"""Offline transport tests: mock DNS/HTTP/socket boundaries; never access a network."""
import io
import json
import socket
import ssl
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import Mock, patch

import cdn_transport as transport


HOST = 'sns-music.xhscdn.com'
PUBLIC_IPS = ['93.184.216.34', '8.8.8.8', '1.1.1.1', '8.8.4.4']


class Response(io.BytesIO):
    def __init__(self, payload, status=200):
        super().__init__(payload if isinstance(payload, bytes) else json.dumps(payload).encode())
        self.status = status


class CDNTransportTests(unittest.TestCase):
    def setUp(self):
        guard = patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden in offline tests'))
        guard.start()
        self.addCleanup(guard.stop)

    def response(self, *records):
        return {'Status': 0, 'Answer': list(records)}

    def a_record(self, ip=PUBLIC_IPS[0], name=HOST):
        return {'name': name + '.', 'type': 1, 'TTL': 60, 'data': ip}

    def resolve(self, payload):
        opener = Mock()
        opener.open.return_value = Response(payload)
        with patch.object(transport.urllib.request, 'build_opener', return_value=opener):
            result = transport.resolve_public_ipv4(HOST)
        return result, opener

    def test_system_dns_success_does_not_query_doh(self):
        raw_socket, tls_socket = Mock(), Mock()
        context = Mock(); context.wrap_socket.return_value = tls_socket
        connection = transport.CDNHTTPSConnection(HOST, timeout=65, context=context)
        with patch.object(transport.socket, 'create_connection', return_value=raw_socket) as connect, \
                patch.object(transport, 'resolve_public_ipv4') as resolve:
            connection.connect()
        connect.assert_called_once_with((HOST, 443), 65, None)
        resolve.assert_not_called()
        context.wrap_socket.assert_called_once_with(raw_socket, server_hostname=HOST)
        self.assertIs(connection.sock, tls_socket)

    def test_fallback_changes_only_socket_target_and_keeps_host_and_tls_name(self):
        raw_socket, tls_socket = Mock(), Mock()
        context = Mock(); context.wrap_socket.return_value = tls_socket
        connection = transport.CDNHTTPSConnection(HOST, timeout=65, context=context)
        with patch.object(transport.socket, 'create_connection', side_effect=[socket.gaierror(8, 'DNS failed'), raw_socket]) as connect, \
                patch.object(transport, 'resolve_public_ipv4', return_value=PUBLIC_IPS[:1]) as resolve:
            connection.connect()
            connection.request('GET', '/private-media?signature=synthetic', headers={'Referer': 'https://www.xiaohongshu.com/'})
        self.assertEqual(connect.call_args_list[0].args, ((HOST, 443), 65, None))
        self.assertEqual(connect.call_args_list[1].args, ((PUBLIC_IPS[0], 443), transport.CONNECT_TIMEOUT, None))
        raw_socket.settimeout.assert_called_once_with(65)
        resolve.assert_called_once_with(HOST)
        context.wrap_socket.assert_called_once_with(raw_socket, server_hostname=HOST)
        transmitted = b''.join(call.args[0] for call in tls_socket.sendall.call_args_list)
        self.assertIn(b'Host: ' + HOST.encode() + b'\r\n', transmitted)
        self.assertNotIn(b'Host: ' + PUBLIC_IPS[0].encode(), transmitted)
        self.assertEqual(connection.host, HOST)

    def test_non_cdn_dns_failure_never_uses_doh(self):
        for host in ('api.galaxysapi.com', 'xhscdn.com.evil.example', 'evilrednotecdn.com', '127.0.0.1'):
            with self.subTest(host=host), patch.object(transport.socket, 'create_connection', side_effect=socket.gaierror(8, 'DNS failed')), \
                    patch.object(transport, 'resolve_public_ipv4') as resolve:
                with self.assertRaises(socket.gaierror):
                    transport.CDNHTTPSConnection._media_connection((host, 443), 65)
                resolve.assert_not_called()

    def test_only_dns_failure_triggers_doh(self):
        for error in (TimeoutError('timeout'), ConnectionRefusedError('refused'), ssl.SSLError('TLS error')):
            with self.subTest(error=type(error).__name__), patch.object(transport.socket, 'create_connection', side_effect=error), \
                    patch.object(transport, 'resolve_public_ipv4') as resolve:
                with self.assertRaises(type(error)):
                    transport.CDNHTTPSConnection._media_connection((HOST, 443), 65)
                resolve.assert_not_called()

    def test_default_trusted_tls_context_and_certificate_failure_are_preserved(self):
        handler = transport.CDNHTTPSHandler()
        request = urllib.request.Request('https://' + HOST + '/private?signature=synthetic')
        with patch.object(handler, 'do_open') as opened:
            handler.https_open(request)
        opened.assert_called_once_with(transport.CDNHTTPSConnection, request, context=handler._context)
        # Python 3.9 creates the default context in HTTPSConnection, whereas
        # newer urllib versions create it in HTTPSHandler. Check the effective
        # connection configuration without connecting or relying on that timing.
        connection_type = opened.call_args.args[0]
        default_connection = connection_type(HOST, **opened.call_args.kwargs)
        self.assertEqual(default_connection._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(default_connection._context.check_hostname)
        context = Mock(); context.wrap_socket.side_effect = ssl.SSLCertVerificationError('certificate mismatch')
        connection = transport.CDNHTTPSConnection(HOST, context=context)
        with patch.object(transport.socket, 'create_connection', return_value=Mock()), \
                patch.object(transport, 'resolve_public_ipv4') as resolve:
            with self.assertRaises(ssl.SSLCertVerificationError): connection.connect()
            resolve.assert_not_called()

    def test_doh_query_sends_only_media_hostname_and_follows_answer_cname_chain(self):
        payload = self.response(self.a_record(PUBLIC_IPS[0], 'edge.apdcdn.example'),
            {'name': HOST + '.', 'type': 5, 'data': 'alias.apdcdn.example.'},
            {'name': 'alias.apdcdn.example.', 'type': 5, 'data': 'edge.apdcdn.example.'},
            self.a_record('127.0.0.1', 'unrelated.example'))
        result, opener = self.resolve(payload)
        self.assertEqual(result, PUBLIC_IPS[:1])
        request = opener.open.call_args.args[0]
        url = urllib.parse.urlsplit(request.full_url)
        self.assertEqual((url.scheme, url.hostname, url.path), ('https', 'dns.google', '/resolve'))
        self.assertEqual(urllib.parse.parse_qs(url.query), {'name': [HOST], 'type': ['A']})
        self.assertEqual(dict(request.header_items()), {'Accept': 'application/dns-json'})
        self.assertIsNone(request.data)
        self.assertEqual(opener.open.call_args.kwargs['timeout'], transport.DOH_TIMEOUT)

    def test_doh_rejects_non_media_names_before_any_request(self):
        for value in ('api.galaxysapi.com', 'https://' + HOST + '/media?signature=synthetic',
                      HOST + ':443', HOST + '..', 'evil' + HOST, '@' + HOST):
            # A longer subdomain is allowed; lookalike suffixes outside the boundary are not.
            if value == 'evil' + HOST: value = 'evilxhscdn.com'
            with self.subTest(value=value), patch.object(transport.urllib.request, 'build_opener') as opened:
                with self.assertRaises(ValueError): transport.resolve_public_ipv4(value)
                opened.assert_not_called()

    def test_private_multicast_reserved_or_invalid_dns_answers_are_rejected(self):
        for ip in ('10.0.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
                   '224.0.0.1', '240.0.0.1', '192.0.2.1', '2606:4700:4700::1111', 'not-an-ip'):
            with self.subTest(ip=ip):
                with self.assertRaises(ValueError): self.resolve(self.response(self.a_record(ip)))

    def test_unrelated_a_records_bad_status_and_invalid_cname_chains_are_rejected(self):
        payloads = [{'Status': 3, 'Answer': [self.a_record()]}, {'Status': 0}, self.response(),
                    self.response(self.a_record(name='unrelated.example')),
                    self.response({'name': HOST + '.', 'type': 5, 'data': HOST + '.'}, self.a_record()),
                    self.response({'name': HOST + '.', 'type': 5, 'data': 'edge1.example.'},
                                  {'name': HOST + '.', 'type': 5, 'data': 'edge2.example.'}, self.a_record()),
                    self.response(*[self.a_record() for _ in range(transport.MAX_ANSWERS + 1)])]
        for payload in payloads:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError): self.resolve(payload)
        with self.assertRaises(ValueError): self.resolve(b'{invalid JSON')
        with self.assertRaises(ValueError): self.resolve(b' ' * (transport.MAX_DOH_BYTES + 1))

    def test_doh_redirects_are_not_followed(self):
        with self.assertRaises(urllib.error.URLError):
            transport._NoDNSRedirect().redirect_request(None, None, 302, '', {}, 'https://unrelated.example/')

    def test_candidates_are_deduplicated_and_bounded_and_tcp_timeout_is_small(self):
        result, _ = self.resolve(self.response(*[self.a_record(ip) for ip in [PUBLIC_IPS[0], *PUBLIC_IPS]]))
        self.assertEqual(result, PUBLIC_IPS[:transport.MAX_ADDRESSES])
        errors = [socket.gaierror(8, 'DNS failed')] + [TimeoutError('connect timeout')] * transport.MAX_ADDRESSES
        with patch.object(transport.socket, 'create_connection', side_effect=errors) as connect, \
                patch.object(transport, 'resolve_public_ipv4', return_value=PUBLIC_IPS):
            with self.assertRaises(TimeoutError):
                transport.CDNHTTPSConnection._media_connection((HOST, 443), 65)
        self.assertEqual(connect.call_count, 1 + transport.MAX_ADDRESSES)
        self.assertTrue(all(call.args[1] == transport.CONNECT_TIMEOUT for call in connect.call_args_list[1:]))


if __name__ == '__main__':
    unittest.main()
