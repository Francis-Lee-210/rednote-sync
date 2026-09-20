"""A media-only DNS fallback that preserves urllib's HTTPS identity checks."""
import http.client
import ipaddress
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request


MEDIA_DOMAINS = ('xhscdn.com', 'rednotecdn.com')
DOH_ORIGIN = 'https://dns.google/resolve'
DOH_TIMEOUT = 5
CONNECT_TIMEOUT = 3
MAX_ADDRESSES = 3
MAX_ANSWERS = 64
MAX_CNAME_HOPS = 8
MAX_DOH_BYTES = 64 * 1024


def _dns_name(value):
    if not isinstance(value, str):
        raise ValueError('Invalid DNS name')
    name = value.removesuffix('.').lower()
    if len(name) > 253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                                for label in name.split('.')):
        raise ValueError('Invalid DNS name')
    return name


def _media_hostname(hostname):
    try:
        host = _dns_name(hostname)
    except ValueError:
        return None
    return host if any(host == domain or host.endswith('.' + domain) for domain in MEDIA_DOMAINS) else None


def _public_answers(hostname, payload):
    """Accept only A records owned by the queried name or its response CNAME chain."""
    if not isinstance(payload, dict) or type(payload.get('Status')) is not int or payload['Status'] != 0:
        raise ValueError('DNS-over-HTTPS did not return a successful answer')
    records = payload.get('Answer')
    if not isinstance(records, list) or len(records) > MAX_ANSWERS:
        raise ValueError('Invalid DNS-over-HTTPS answer list')
    aliases, addresses = {}, []
    for record in records:
        if not isinstance(record, dict):
            raise ValueError('Invalid DNS record')
        if record.get('type') not in (1, 5):
            continue
        owner = _dns_name(record.get('name'))
        if record['type'] == 5:
            target = _dns_name(record.get('data'))
            if owner in aliases and aliases[owner] != target:
                raise ValueError('Ambiguous DNS CNAME record')
            aliases[owner] = target
        else:
            addresses.append((owner, record.get('data')))
    chain, current = {hostname}, hostname
    for _ in range(MAX_CNAME_HOPS):
        if current not in aliases:
            break
        current = aliases[current]
        if current in chain:
            raise ValueError('DNS CNAME loop')
        chain.add(current)
    else:
        if current in aliases:
            raise ValueError('DNS CNAME chain exceeds the limit')
    result = []
    for owner, value in addresses:
        if owner not in chain:
            continue
        if not isinstance(value, str):
            raise ValueError('Invalid IPv4 DNS answer')
        try:
            address = ipaddress.IPv4Address(value)
        except ipaddress.AddressValueError:
            raise ValueError('Invalid IPv4 DNS answer') from None
        if not address.is_global or address.is_multicast or address.is_reserved:
            raise ValueError('DNS answer is not public unicast IPv4')
        value = str(address)
        if value not in result:
            result.append(value)
    if not result:
        raise ValueError('No public IPv4 answer for the media hostname')
    return result[:MAX_ADDRESSES]


class _NoDNSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.URLError('DNS-over-HTTPS redirects are disabled')


def resolve_public_ipv4(hostname):
    """Query a fixed trusted resolver with only an allowed media hostname."""
    host = _media_hostname(hostname)
    if host is None:
        raise ValueError('DNS fallback requires an allowed media hostname')
    query = urllib.parse.urlencode({'name': host, 'type': 'A'})
    request = urllib.request.Request(DOH_ORIGIN + '?' + query, headers={'Accept': 'application/dns-json'})
    # This separate default opener cannot recurse into the media fallback or inherit
    # the media request's URL, cookies, Referer, or authorization headers.
    opener = urllib.request.build_opener(_NoDNSRedirect())
    with opener.open(request, timeout=DOH_TIMEOUT) as response:
        if response.status != 200:
            raise ValueError('DNS-over-HTTPS did not return HTTP 200')
        body = response.read(MAX_DOH_BYTES + 1)
    if len(body) > MAX_DOH_BYTES:
        raise ValueError('DNS-over-HTTPS response exceeds the limit')
    return _public_answers(host, json.loads(body))


class CDNHTTPSConnection(http.client.HTTPSConnection):
    """Change only the TCP destination; HTTPSConnection retains Host and TLS SNI."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = self._media_connection

    @staticmethod
    def _media_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
        try:
            return socket.create_connection(address, timeout, source_address)
        except socket.gaierror:
            host = _media_hostname(address[0])
            if host is None:
                raise
        addresses = resolve_public_ipv4(host)
        original_timeout = socket.getdefaulttimeout() if timeout is socket._GLOBAL_DEFAULT_TIMEOUT else timeout
        connect_timeout = CONNECT_TIMEOUT if original_timeout is None else min(original_timeout, CONNECT_TIMEOUT)
        last_error = None
        for ip in addresses[:MAX_ADDRESSES]:
            try:
                sock = socket.create_connection((ip, address[1]), connect_timeout, source_address)
            except OSError as error:
                last_error = error
                continue
            # The smaller TCP retry timeout must not shorten TLS or media reads.
            sock.settimeout(original_timeout)
            return sock
        if last_error is not None:
            raise last_error
        raise socket.gaierror(socket.EAI_NONAME, 'No public media DNS candidate')


class CDNHTTPSHandler(urllib.request.HTTPSHandler):
    """Pass to build_opener(CDRedirect(), CDNHTTPSHandler()) for media requests."""
    def __init__(self):
        # Keep the standard trusted SSL context and hostname verification enabled.
        super().__init__()

    def https_open(self, req):
        return self.do_open(CDNHTTPSConnection, req, context=self._context)
