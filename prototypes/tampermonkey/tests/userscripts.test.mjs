import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('../', import.meta.url));
const flush = () => new Promise(resolve => setImmediate(resolve));

// Only the browser facilities used by these userscripts are simulated. The
// entire installed script, its injected page hook and UI callbacks run as-is.
function loadScript(filename, { loading = false, isolatedPage = false } = {}) {
    const errors = [];
    const intervals = new Map();
    const responses = [];
    const pageResponses = [];
    const exports = [];
    let nextInterval = 1;
    let context;
    let pageContext;

    class Events {
        listeners = new Map();
        addEventListener(type, listener) {
            const listeners = this.listeners.get(type) || [];
            listeners.push(listener);
            this.listeners.set(type, listeners);
        }
        dispatchEvent(event) {
            for (const listener of this.listeners.get(event.type) || []) {
                listener.call(this, event);
            }
        }
    }

    class Element extends Events {
        constructor(tagName) {
            super();
            this.tagName = tagName.toUpperCase();
            this.children = [];
            this.style = {};
            this.className = '';
            this.classList = { add() {}, remove() {} };
            this.textContent = '';
        }
        appendChild(child) {
            child.parentElement = this;
            this.children.push(child);
            if (child.tagName === 'SCRIPT') vm.runInContext(child.textContent, pageContext);
            return child;
        }
        remove() {
            const siblings = this.parentElement.children;
            siblings.splice(siblings.indexOf(this), 1);
        }
        click() { this.dispatchEvent({ type: 'click', target: this, currentTarget: this }); }
    }

    const document = new Events();
    document.documentElement = new Element('html');
    document.head = new Element('head');
    document.body = new Element('body');
    document.documentElement.appendChild(document.head);
    document.documentElement.appendChild(document.body);
    document.readyState = loading ? 'loading' : 'complete';
    document.createElement = tagName => new Element(tagName);
    const descendants = (node = document.documentElement) =>
        [node, ...node.children.flatMap(child => descendants(child))];
    document.getElementById = id => descendants().find(node => node.id === id) || null;
    document.querySelector = selector => {
        const match = /^\.([\w-]+)(:last-child)?$/.exec(selector);
        assert.ok(match, `Unhandled selector ${selector}`);
        return descendants().find(node => node.className.split(' ').includes(match[1]) &&
            (!match[2] || node.parentElement?.children.at(-1) === node)) || null;
    };

    function createXHR() {
        return class extends Events {
            open() {}
            send() {}
            respond(data) {
                this.responseText = JSON.stringify(data);
                this.dispatchEvent({ type: 'load' });
            }
        };
    }
    const XHR = createXHR();
    const createFetch = queue => async () => {
        const data = await queue.shift();
        return { clone: () => ({
            text: async () => JSON.stringify(data),
            json: async () => data,
        }) };
    };

    class BrowserURL extends URL {
        static createObjectURL(blob) { exports.push(blob); return 'blob:synthetic-export'; }
        static revokeObjectURL() {}
    }

    const window = Object.assign(new Events(), {
        document,
        location: new URL('https://www.xiaohongshu.com/user/profile/synthetic-owner?tab=liked'),
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        scrollTo() {},
        fetch: createFetch(responses),
    });
    Object.assign(window, {
        window,
        URL: BrowserURL,
        URLSearchParams,
        Blob,
        XMLHttpRequest: XHR,
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        console: { error: (...args) => errors.push(args), log() {} },
        localStorage: { getItem: () => null, setItem() {} },
        GM_addStyle() {},
        GM_xmlhttpRequest() { throw new Error('Unexpected network request'); },
        setInterval: callback => { const id = nextInterval++; intervals.set(id, callback); return id; },
        clearInterval: id => intervals.delete(id),
        setTimeout() { throw new Error('Unexpected timeout'); },
        alert() {},
        XLSX: {
            utils: {
                json_to_sheet: notes => { exports.push(JSON.parse(JSON.stringify(notes))); return {}; },
                book_new: () => ({}),
                book_append_sheet() {},
            },
            writeFile() {},
        },
    });
    context = vm.createContext(window);
    // A userscript sandbox and page can have separate network globals. Only
    // the shared DOM event bridge delivers page responses back to the script.
    const pageWindow = isolatedPage ? {
        document,
        XMLHttpRequest: createXHR(),
        fetch: createFetch(pageResponses),
        CustomEvent: window.CustomEvent,
        dispatchEvent: event => window.dispatchEvent(event),
    } : window;
    pageWindow.window = pageWindow;
    pageContext = isolatedPage ? vm.createContext(pageWindow) : context;
    vm.runInContext(readFileSync(path.join(scriptDir, filename), 'utf8'), context, { filename });
    assert.deepEqual(errors, [], 'Script initialisation');

    return {
        document, window, intervals, errors,
        ready() {
            document.readyState = 'complete';
            document.dispatchEvent({ type: 'DOMContentLoaded' });
        },
        fetch(url, data) {
            responses.push(data);
            return window.fetch(url);
        },
        xhr(url) { const xhr = new XHR(); xhr.open('GET', url); xhr.send(); return xhr; },
        pageFetch(url, data) {
            (isolatedPage ? pageResponses : responses).push(data);
            return pageWindow.fetch(url);
        },
        pageXhr(url) {
            const xhr = new pageWindow.XMLHttpRequest();
            xhr.open('GET', url);
            xhr.send();
            return xhr;
        },
        async exportedNotes() {
            descendants().find(node => node.tagName === 'BUTTON' && node.textContent.startsWith('导出')).click();
            await flush();
            const result = exports.at(-1);
            return result instanceof Blob ? JSON.parse(await result.text()).notes : result;
        },
    };
}

const note = (id, liked) => ({
    note_id: id,
    xsec_token: 'synthetic-access-material',
    display_title: 'Synthetic note',
    user: { user_id: 'synthetic-author' },
    interact_info: { liked },
});
const payload = (...notes) => ({ success: true, data: { notes } });
const likedUrl = '/api/sns/web/v2/note/like/page';
const likedVariantUrl = '/api/sns/web/v3/note/liked/page?cursor=synthetic';
const collectUrl = '/api/sns/web/v2/note/collect/page';

for (const [filename, counterId] of [
    ['xiaohongshu-like-export.user.js', 'xhs-like-counter'],
    ['xiaohongshu-like-export-json.user.js', 'xhs-like-json-counter'],
]) {
    test(`${filename}: BUG-001 ignores non-liked collection responses`, async () => {
        const page = loadScript(filename);
        await page.fetch(collectUrl, payload(note('not-liked', false)));
        await flush();
        assert.equal(page.document.getElementById(counterId).textContent, '已获取点赞：0');
    });
    test(`${filename}: explicit liked list remains collectable`, async () => {
        const page = loadScript(filename);
        await page.fetch(likedUrl, payload(note('liked', true)));
        await flush();
        assert.deepEqual((await page.exportedNotes()).map(note => note.note_id), ['liked']);
    });
    test(`${filename}: liked endpoint variant contributes its own note via XHR`, async () => {
        const page = loadScript(filename);
        page.xhr(likedVariantUrl).respond(payload(note('liked-variant-only', true)));
        assert.deepEqual((await page.exportedNotes()).map(note => note.note_id), ['liked-variant-only']);
        assert.equal(page.document.getElementById(counterId).textContent, '已获取点赞：1');
    });
    test(`${filename}: injected page hook bridges isolated Fetch and XHR responses`, async () => {
        const page = loadScript(filename, { isolatedPage: true });
        await page.pageFetch(likedUrl, payload(note('page-fetch-only', true)));
        await flush();
        assert.equal(page.document.getElementById(counterId).textContent, '已获取点赞：1');
        page.pageXhr(likedVariantUrl).respond(payload(note('page-xhr-only', true)));
        assert.deepEqual((await page.exportedNotes()).map(note => note.note_id), ['page-fetch-only', 'page-xhr-only']);
        await page.pageFetch(collectUrl, payload(note('page-collection', true)));
        await flush();
        assert.equal(page.document.getElementById(counterId).textContent, '已获取点赞：2');
        assert.deepEqual(page.errors, []);
    });
    test(`${filename}: collection and unknown routes never establish liked-list membership`, async () => {
        const page = loadScript(filename);
        for (const search of ['?tab=liked', '?tab=collect']) {
            page.window.location.search = search;
            for (const url of [collectUrl, '/api/sns/web/v2/note/recommend/page', '/other?next=' + likedUrl]) {
                await page.fetch(url, payload(note('all-liked', true)));
                await page.fetch(url, payload(note('mixed-yes', true), note('mixed-no', false)));
            }
        }
        await flush();
        assert.equal(page.document.getElementById(counterId).textContent, '已获取点赞：0');
    });
    test(`${filename}: delayed liked response survives a tab switch and duplicate delivery`, async () => {
        const page = loadScript(filename);
        let resolve;
        const waiting = new Promise(done => { resolve = done; });
        const pending = page.fetch(likedUrl, waiting);
        page.window.location.search = '?tab=collect';
        resolve(payload(note('delayed', true)));
        await pending;
        page.xhr(likedUrl).respond(payload(note('delayed', true)));
        await flush();
        assert.deepEqual((await page.exportedNotes()).map(note => note.note_id), ['delayed']);
        assert.equal(page.document.getElementById(counterId).textContent, '已获取点赞：1');
    });
    test(`${filename}: delayed collection response does not become a liked response after switching tabs`, async () => {
        const page = loadScript(filename);
        page.window.location.search = '?tab=collect';
        const request = page.xhr(collectUrl);
        page.window.location.search = '?tab=liked';
        request.respond(payload(note('not-liked', false)));
        assert.equal(page.document.getElementById(counterId).textContent, '已获取点赞：0');
    });
    test(`${filename}: document-start response remains visible when UI is mounted`, async () => {
        const page = loadScript(filename, { loading: true });
        await page.fetch(likedUrl, payload(note('first-screen', true)));
        await flush();
        page.ready();
        assert.equal(page.document.getElementById(counterId).textContent, '已获取点赞：1');
        assert.deepEqual((await page.exportedNotes()).map(note => note.note_id), ['first-screen']);
    });
    test(`${filename}: malformed IDs are skipped without blocking later notes`, async () => {
        const page = loadScript(filename);
        await page.fetch(likedUrl, payload({}, note('', true), note('   ', true), note(0, true), note('valid', true)));
        await flush();
        assert.deepEqual((await page.exportedNotes()).map(note => note.note_id), ['valid']);
        assert.equal(page.document.getElementById(counterId).textContent, '已获取点赞：1');
        assert.deepEqual(page.errors, []);
    });
    test(`${filename}: a null entry does not discard the rest of the page`, async () => {
        const page = loadScript(filename);
        await page.fetch(likedUrl, payload(null, note('valid', true)));
        await flush();
        assert.deepEqual((await page.exportedNotes()).map(note => note.note_id), ['valid']);
        assert.deepEqual(page.errors, []);
    });
}

test('collection: malformed IDs are skipped without exporting Unknown as a note ID', async () => {
    const page = loadScript('xiaohongshu-collection-export.user.js');
    await page.fetch(collectUrl, payload({}, note('', true), note('   ', true), note(0, true), note('valid', false)));
    await flush();
    assert.deepEqual((await page.exportedNotes()).map(note => note.note_id), ['valid']);
    assert.deepEqual(page.errors, []);
});

test('collection: a zero like count stays zero', async () => {
    const page = loadScript('xiaohongshu-collection-export.user.js');
    const valid = note('valid', false);
    valid.interact_info.liked_count = 0;
    await page.fetch(collectUrl, payload(valid));
    await flush();
    const notes = await page.exportedNotes();
    assert.deepEqual(notes.map(note => note.note_id), ['valid']);
    assert.equal(notes[0].liked_count, 0);
    assert.deepEqual(page.errors, []);
});

test('collection: a null entry does not discard the rest of the page', async () => {
    const page = loadScript('xiaohongshu-collection-export.user.js');
    page.xhr(collectUrl).respond(payload(null, note('valid', false)));
    assert.deepEqual((await page.exportedNotes()).map(note => note.note_id), ['valid']);
    assert.deepEqual(page.errors, []);
});

test('collection: BUG-002 start / stop / restart with credit after scroll button', () => {
    const page = loadScript('xiaohongshu-collection-export.user.js');
    const container = page.document.querySelector('.xhs-tool-container');
    const button = container.children.find(node => node.textContent === '自动滚动获取');
    assert.equal(container.children.at(-1).className, 'powered-by');
    for (const expectedIntervals of [1, 0, 1, 0]) {
        button.click();
        assert.equal(page.intervals.size, expectedIntervals);
        assert.equal(button.textContent, expectedIntervals ? '停止滚动' : '自动滚动获取');
    }
});
