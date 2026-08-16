// ==UserScript==
// @name         小红书点赞帖子导出工具
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  导出小红书点赞帖子列表为 Excel，不拼接帖子链接
// @match        https://www.xiaohongshu.com/user/profile/*
// @icon         https://www.xiaohongshu.com/favicon.ico
// @grant        GM_addStyle
// @require      https://unpkg.com/xlsx/dist/xlsx.full.min.js
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const collectedNotes = [];
    const seenNoteIds = new Set();
    let isAutoScrolling = false;
    let scrollInterval = null;

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
        .xhs-like-tool-container {
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
        .xhs-like-tool-container.dragging {
            opacity: 0.9;
            cursor: grabbing !important;
        }
        .xhs-like-tool-container.snapping {
            transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .xhs-like-button {
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
        .xhs-like-button:hover {
            background: linear-gradient(135deg, #ff2442 0%, #ff3850 100%);
            transform: translateY(-1px);
            box-shadow: 0 6px 20px rgba(255, 36, 66, 0.3);
        }
        .xhs-like-button:active {
            transform: translateY(1px);
            box-shadow: 0 2px 10px rgba(255, 36, 66, 0.2);
        }
        .xhs-like-counter {
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
        if (document.getElementById('xhs-like-tool-container')) return;

        const container = document.createElement('div');
        container.id = 'xhs-like-tool-container';
        container.className = 'xhs-like-tool-container';

        const counter = document.createElement('div');
        counter.id = 'xhs-like-counter';
        counter.className = 'xhs-like-counter';
        counter.textContent = '已获取点赞：0';

        const exportButton = document.createElement('button');
        exportButton.className = 'xhs-like-button';
        exportButton.textContent = '导出点赞帖子';
        exportButton.addEventListener('click', exportToExcel);

        const scrollButton = document.createElement('button');
        scrollButton.id = 'xhs-like-scroll-button';
        scrollButton.className = 'xhs-like-button';
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

    function getRequestUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
        return String(input || '');
    }

    function hasNotesPayload(data) {
        return Boolean(data && data.success === true && data.data && Array.isArray(data.data.notes));
    }

    function isLikeTabPage() {
        const params = new URLSearchParams(window.location.search);
        const tab = (params.get('tab') || '').toLowerCase();
        const subTab = (params.get('subTab') || '').toLowerCase();
        return tab.includes('like') || subTab.includes('like') || tab.includes('liked') || subTab.includes('liked');
    }

    function shouldProcessResponse(url, data) {
        if (!hasNotesPayload(data)) return false;

        const requestUrl = String(url);
        const isLikeEndpoint = /api\/sns\/web\/v\d+\/note\/(?:like|liked)\/page/i.test(requestUrl);
        if (isLikeEndpoint) return true;

        const isPossibleNoteList = /api\/sns\/web\//i.test(requestUrl);
        const hasLikedField = data.data.notes.some(note => (
            note && note.interact_info && Object.prototype.hasOwnProperty.call(note.interact_info, 'liked')
        ));

        return isLikeTabPage() && isPossibleNoteList && hasLikedField;
    }

    function shouldInspectUrl(url) {
        const requestUrl = String(url);
        return /api\/sns\/web\/v\d+\/note\/(?:like|liked)\/page/i.test(requestUrl)
            || (isLikeTabPage() && /api\/sns\/web\//i.test(requestUrl));
    }

    function interceptXHR() {
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            const requestUrl = getRequestUrl(url);
            if (!shouldInspectUrl(requestUrl)) {
                return originalOpen.apply(this, arguments);
            }

            this.addEventListener('load', function() {
                try {
                    const data = JSON.parse(this.responseText);
                    if (shouldProcessResponse(requestUrl, data)) {
                        processNotes(data.data.notes);
                    }
                } catch (error) {
                    console.error('解析点赞响应数据失败:', error);
                }
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
                if (shouldProcessResponse(requestUrl, data)) {
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
            const noteId = readValue(note.note_id);
            if (seenNoteIds.has(noteId)) return;

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
        const counter = document.getElementById('xhs-like-counter');
        if (counter) {
            counter.textContent = `已获取点赞：${collectedNotes.length}`;
        }
    }

    function exportToExcel() {
        if (collectedNotes.length === 0) {
            alert('暂未获取到点赞数据，请先打开点赞页面并浏览列表');
            return;
        }

        const worksheet = XLSX.utils.json_to_sheet(collectedNotes);
        worksheet['!cols'] = [
            {wch: 30}, // note_id
            {wch: 50}, // display_title
            {wch: 12}, // type
            {wch: 50}, // xsec_token
            {wch: 20}, // interact_info.liked
            {wch: 24}, // interact_info.liked_count
            {wch: 30}, // user.user_id
            {wch: 20}, // user.nickname
            {wch: 60}, // user.avatar
            {wch: 50}, // user.xsec_token
            {wch: 60}, // cover.url_pre
            {wch: 60} // cover.url_default
        ];

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, '点赞帖子');
        XLSX.writeFile(workbook, `小红书点赞帖子_${new Date().toISOString().slice(0, 10)}.xlsx`);
    }

    function toggleAutoScroll() {
        const scrollButton = document.getElementById('xhs-like-scroll-button');
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

        const savedPosition = localStorage.getItem('xhs-like-tool-position');
        if (savedPosition) {
            try {
                const { x, y } = JSON.parse(savedPosition);
                container.style.right = 'auto';
                container.style.left = `${x}px`;
                container.style.top = `${y}px`;
            } catch (error) {
                console.error('恢复点赞导出工具位置失败:', error);
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
            localStorage.setItem('xhs-like-tool-position', JSON.stringify({ x: currentX, y: currentY }));

            setTimeout(() => container.classList.remove('snapping'), 300);
        }

        container.addEventListener('mousedown', dragStart);
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);
    }

    function init() {
        createUI();
    }

    interceptXHR();
    interceptFetch();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
