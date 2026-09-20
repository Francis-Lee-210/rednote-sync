// ==UserScript==
// @name         小红书点赞帖子 JSON 导出工具
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  导出小红书点赞帖子列表为 JSON，不拼接帖子链接
// @match        https://www.xiaohongshu.com/user/profile/*
// @icon         https://www.xiaohongshu.com/favicon.ico
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const RESPONSE_EVENT_NAME = 'xhs-like-json-export-response';
    const collectedNotes = [];
    const seenNoteIds = new Set();
    let isAutoScrolling = false;
    let scrollInterval = null;

    injectPageNetworkHook();
    window.addEventListener(RESPONSE_EVENT_NAME, event => {
        const detail = event.detail || {};
        handleResponseText(detail.url, detail.body);
    });

    function isDarkMode() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function updateTheme(container, isDark) {
        if (isDark) {
            container.style.background = 'rgba(0, 0, 0, 0.7)';
            container.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        } else {
            container.style.background = 'rgba(255, 255, 255, 0.15)';
            container.style.border = '1px solid rgba(255, 255, 255, 0.18)';
        }
    }

    function initThemeListener(container) {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        if (mediaQuery.addEventListener) {
            mediaQuery.addEventListener('change', e => updateTheme(container, e.matches));
        }
    }

    GM_addStyle(`
        .xhs-like-json-tool-container {
            position: fixed;
            top: 20px;
            right: 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            z-index: 9999;
            padding: 15px;
            border-radius: 16px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            cursor: grab;
            transition: all 0s ease;
        }
        .xhs-like-json-tool-container.dragging {
            opacity: 0.9;
            cursor: grabbing !important;
        }
        .xhs-like-json-tool-container.snapping {
            transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .xhs-like-json-button {
            padding: 12px 24px;
            background: linear-gradient(135deg, #ff2442 0%, #ff4d64 100%);
            color: white;
            border: none;
            border-radius: 12px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(255, 36, 66, 0.2);
        }
        .xhs-like-json-button:hover {
            background: linear-gradient(135deg, #ff2442 0%, #ff3850 100%);
            transform: translateY(-1px);
            box-shadow: 0 6px 20px rgba(255, 36, 66, 0.3);
        }
        .xhs-like-json-button:active {
            transform: translateY(1px);
            box-shadow: 0 2px 10px rgba(255, 36, 66, 0.2);
        }
        .xhs-like-json-counter {
            min-width: 180px;
            padding: 12px 24px;
            background: rgba(0, 0, 0, 0.6);
            color: white;
            border-radius: 12px;
            text-align: center;
            font-size: 14px;
            font-weight: 500;
            white-space: nowrap;
            border: 1px solid rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
        }
    `);

    function createUI() {
        if (document.getElementById('xhs-like-json-tool-container')) return;

        const container = document.createElement('div');
        container.id = 'xhs-like-json-tool-container';
        container.className = 'xhs-like-json-tool-container';

        const counter = document.createElement('div');
        counter.id = 'xhs-like-json-counter';
        counter.className = 'xhs-like-json-counter';
        counter.textContent = '已获取点赞：0';

        const exportButton = document.createElement('button');
        exportButton.className = 'xhs-like-json-button';
        exportButton.textContent = '导出点赞帖子 JSON';
        exportButton.addEventListener('click', exportToJson);

        const scrollButton = document.createElement('button');
        scrollButton.id = 'xhs-like-json-scroll-button';
        scrollButton.className = 'xhs-like-json-button';
        scrollButton.textContent = '自动滚动获取';
        scrollButton.addEventListener('click', toggleAutoScroll);

        container.appendChild(counter);
        container.appendChild(exportButton);
        container.appendChild(scrollButton);
        document.body.appendChild(container);

        initDraggable(container);
        updateTheme(container, isDarkMode());
        initThemeListener(container);
    }

    function injectPageNetworkHook() {
        try {
            const target = document.documentElement || document.head || document.body;
            if (!target) return;

            const script = document.createElement('script');
            script.textContent = `(() => {
            const eventName = ${JSON.stringify(RESPONSE_EVENT_NAME)};
            if (window.__xhsLikeJsonExportNetworkHookInstalled) return;
            window.__xhsLikeJsonExportNetworkHookInstalled = true;

            const shouldCaptureUrl = url => /api\\/sns\\/web\\//i.test(String(url || ''));
            const getRequestUrl = input => {
                if (typeof input === 'string') return input;
                if (input && typeof input.url === 'string') return input.url;
                return String(input || '');
            };
            const emitResponse = (url, body) => {
                if (!shouldCaptureUrl(url) || typeof body !== 'string') return;
                window.dispatchEvent(new CustomEvent(eventName, {
                    detail: { url, body }
                }));
            };

            const originalFetch = window.fetch;
            if (typeof originalFetch === 'function') {
                window.fetch = function(input, init) {
                    const requestUrl = getRequestUrl(input);
                    return originalFetch.apply(this, arguments).then(response => {
                        try {
                            response.clone().text().then(body => emitResponse(requestUrl, body)).catch(() => {});
                        } catch (error) {}
                        return response;
                    });
                };
            }

            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(method, url) {
                this.__xhsLikeJsonExportRequestUrl = getRequestUrl(url);
                return originalOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function() {
                this.addEventListener('load', function() {
                    try {
                        emitResponse(this.__xhsLikeJsonExportRequestUrl, this.responseText);
                    } catch (error) {}
                });
                return originalSend.apply(this, arguments);
            };
        })();`;

            target.appendChild(script);
            script.remove();
        } catch (error) {
            console.error('安装点赞 JSON 导出网络监听失败:', error);
        }
    }

    function getRequestUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
        return String(input || '');
    }

    function hasNotesPayload(data) {
        return Boolean(data && data.success === true && data.data && Array.isArray(data.data.notes));
    }

    function shouldInspectUrl(url) {
        try {
            const { pathname } = new URL(url, window.location.href);
            // The request identifies the list; a later tab switch or a note's
            // viewer-specific liked flag cannot establish list membership.
            return /^\/api\/sns\/web\/v\d+\/note\/(?:like|liked)\/page$/i.test(pathname);
        } catch {
            return false;
        }
    }

    function handleResponseText(url, responseText) {
        if (!shouldInspectUrl(url) || typeof responseText !== 'string') return;

        try {
            const data = JSON.parse(responseText);
            if (hasNotesPayload(data)) {
                processNotes(data.data.notes);
            }
        } catch (error) {
            console.error('解析点赞 JSON 响应数据失败:', error);
        }
    }

    function interceptXHR() {
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            const requestUrl = getRequestUrl(url);
            if (!shouldInspectUrl(requestUrl)) {
                return originalOpen.apply(this, arguments);
            }

            this.addEventListener('load', function() {
                handleResponseText(requestUrl, this.responseText);
            });
            return originalOpen.apply(this, arguments);
        };
    }

    function interceptFetch() {
        const originalFetch = window.fetch;
        window.fetch = async function(input, options) {
            const requestUrl = getRequestUrl(input);
            const response = await originalFetch.apply(this, arguments);
            if (!shouldInspectUrl(requestUrl)) {
                return response;
            }

            response.clone().json().then(data => {
                if (hasNotesPayload(data)) {
                    processNotes(data.data.notes);
                }
            }).catch(() => {
                // Ignore non-JSON responses.
            });
            return response;
        };
    }

    function readBoolean(value) {
        if (value === true || value === false) return value;
        return 'Unknown';
    }

    function readValue(value) {
        return value === undefined || value === null || value === '' ? 'Unknown' : value;
    }

    function processNotes(notes) {
        notes.forEach(note => {
            const noteId = typeof note?.note_id === 'string' ? note.note_id.trim() : '';
            if (!noteId || seenNoteIds.has(noteId)) return;

            seenNoteIds.add(noteId);
            collectedNotes.push({
                note_id: noteId,
                display_title: readValue(note.display_title),
                type: readValue(note.type),
                xsec_token: readValue(note.xsec_token),
                'interact_info.liked': readBoolean(note.interact_info?.liked),
                'interact_info.liked_count': readValue(note.interact_info?.liked_count),
                'user.user_id': readValue(note.user?.user_id),
                'user.nickname': readValue(note.user?.nickname),
                'user.avatar': readValue(note.user?.avatar),
                'user.xsec_token': readValue(note.user?.xsec_token),
                'cover.url_pre': readValue(note.cover?.url_pre),
                'cover.url_default': readValue(note.cover?.url_default)
            });
        });

        updateCounter();
    }

    function updateCounter() {
        const counter = document.getElementById('xhs-like-json-counter');
        if (counter) {
            counter.textContent = `已获取点赞：${collectedNotes.length}`;
        }
    }

    function exportToJson() {
        if (collectedNotes.length === 0) {
            alert('暂未获取到点赞数据，请先打开点赞页面并浏览列表');
            return;
        }

        const exportedAt = new Date();
        const payload = {
            schema_version: '1.0',
            source: 'liked',
            exported_at: exportedAt.toISOString(),
            count: collectedNotes.length,
            notes: collectedNotes
        };
        const blob = new Blob(
            [JSON.stringify(payload, null, 2)],
            { type: 'application/json;charset=utf-8' }
        );
        const objectUrl = URL.createObjectURL(blob);
        const downloadLink = document.createElement('a');
        downloadLink.href = objectUrl;
        downloadLink.download = `小红书点赞帖子_${exportedAt.toISOString().slice(0, 10)}.json`;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
        URL.revokeObjectURL(objectUrl);
    }

    function toggleAutoScroll() {
        const scrollButton = document.getElementById('xhs-like-json-scroll-button');
        if (isAutoScrolling) {
            stopAutoScroll();
            if (scrollButton) {
                scrollButton.textContent = '自动滚动获取';
                scrollButton.style.background = 'linear-gradient(135deg, #ff2442 0%, #ff4d64 100%)';
            }
        } else {
            startAutoScroll();
            if (scrollButton) {
                scrollButton.textContent = '停止滚动';
                scrollButton.style.background = 'linear-gradient(135deg, #666 0%, #888 100%)';
            }
        }
        isAutoScrolling = !isAutoScrolling;
    }

    function startAutoScroll() {
        stopAutoScroll();
        scrollInterval = setInterval(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
        }, 1500);
    }

    function stopAutoScroll() {
        if (scrollInterval) {
            clearInterval(scrollInterval);
            scrollInterval = null;
        }
    }

    function initDraggable(container) {
        let isDragging = false;
        let currentX = 0;
        let currentY = 0;
        let initialX = 0;
        let initialY = 0;

        const savedPosition = localStorage.getItem('xhs-like-json-tool-position');
        if (savedPosition) {
            try {
                const { x, y } = JSON.parse(savedPosition);
                container.style.right = 'auto';
                container.style.left = `${x}px`;
                container.style.top = `${y}px`;
            } catch (error) {
                console.error('恢复点赞 JSON 导出工具位置失败:', error);
            }
        }

        function dragStart(e) {
            if (e.target.tagName === 'BUTTON') return;

            const rect = container.getBoundingClientRect();
            initialX = e.clientX - rect.left;
            initialY = e.clientY - rect.top;
            isDragging = true;
            container.classList.add('dragging');
        }

        function drag(e) {
            if (!isDragging) return;

            e.preventDefault();
            const rect = container.getBoundingClientRect();
            const safeDistance = 20;
            currentX = Math.min(
                Math.max(e.clientX - initialX, safeDistance),
                window.innerWidth - rect.width - safeDistance
            );
            currentY = Math.min(
                Math.max(e.clientY - initialY, safeDistance),
                window.innerHeight - rect.height - safeDistance
            );

            container.style.left = `${currentX}px`;
            container.style.top = `${currentY}px`;
            container.style.right = 'auto';
        }

        function dragEnd() {
            if (!isDragging) return;

            isDragging = false;
            container.classList.remove('dragging');
            container.classList.add('snapping');

            const rect = container.getBoundingClientRect();
            const safeDistance = 20;
            currentX = rect.left < window.innerWidth / 2
                ? safeDistance
                : window.innerWidth - rect.width - safeDistance;
            currentY = Math.min(
                Math.max(rect.top, safeDistance),
                window.innerHeight - rect.height - safeDistance
            );

            container.style.left = `${currentX}px`;
            container.style.top = `${currentY}px`;
            container.style.right = 'auto';
            localStorage.setItem('xhs-like-json-tool-position', JSON.stringify({ x: currentX, y: currentY }));

            setTimeout(() => container.classList.remove('snapping'), 300);
        }

        container.addEventListener('mousedown', dragStart);
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);
    }

    function init() {
        createUI();
        updateCounter();
    }

    interceptXHR();
    interceptFetch();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
