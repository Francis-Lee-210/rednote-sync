// ==UserScript==
// @name         小红书收藏夹导出工具
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  自动导出小红书收藏夹内容为Excel格式
// @match        https://www.xiaohongshu.com/user/profile/*
// @icon         https://www.xiaohongshu.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @require      https://unpkg.com/xlsx/dist/xlsx.full.min.js
// @author       @AI产品银海
// ==/UserScript==

(function() {
    'use strict';

    // 存储收藏数据
    let collectedNotes = [];

    // 检测系统主题
    function isDarkMode() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    // 监听系统主题变化
    function initThemeListener(container) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
            updateTheme(container, e.matches);
        });
    }

    // 更新主题样式
    function updateTheme(container, isDark) {
        if (isDark) {
            container.style.background = 'rgba(0, 0, 0, 0.7)';
            container.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        } else {
            container.style.background = 'rgba(255, 255, 255, 0.15)';
            container.style.border = '1px solid rgba(255, 255, 255, 0.18)';
        }
    }

    // 添加按钮和计数器的样式
    GM_addStyle(`
        /* 拖动时的样式 */
        .xhs-tool-container.dragging {
            opacity: 0.9;
            cursor: grabbing !important;
        }
        .xhs-tool-container {
            position: fixed;
            top: 20px;
            right: 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            z-index: 9999;
            background: ${isDarkMode() ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.15)'};
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            padding: 15px;
            border-radius: 16px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.18);
            cursor: grab;
            transition: all 0s ease;
        }
        .xhs-tool-container.snapping {
            transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .xhs-tool-container:hover {
            background: rgba(255, 255, 255, 0.25);
        }
        .xhs-button {
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
        .xhs-button:hover {
            background: linear-gradient(135deg, #ff2442 0%, #ff3850 100%);
            transform: translateY(-1px);
            box-shadow: 0 6px 20px rgba(255, 36, 66, 0.3);
        }
        .xhs-button:active {
            transform: translateY(1px);
            box-shadow: 0 2px 10px rgba(255, 36, 66, 0.2);
        }
        .note-counter {
            background: rgba(0, 0, 0, 0.6);
            color: white;
            padding: 12px 24px;
            min-width: 180px;
            white-space: nowrap;
            border-radius: 12px;
            text-align: center;
            font-size: 14px;
            font-weight: 500;
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            border: 1px solid rgba(255, 255, 255, 0.1);
        letter-spacing: 0.5px;
    }
    .powered-by {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.7);
        text-align: center;
        margin-top: 5px;
    }
    .powered-by a {
        color: rgba(255, 255, 255, 0.9);
        text-decoration: none;
        font-weight: 500;
    }
    .powered-by a:hover {
        text-decoration: underline;
    }
`);

    // 创建UI元素
    function createUI() {
        const container = document.createElement('div');
        container.className = 'xhs-tool-container';

        // 创建计数器
        const counter = document.createElement('div');
        counter.className = 'note-counter';
        counter.textContent = '已获取笔记：0';
        counter.id = 'note-counter';

        // 创建导出按钮
        const exportButton = document.createElement('button');
        exportButton.className = 'xhs-button';
        exportButton.textContent = '导出收藏夹';
        exportButton.addEventListener('click', exportToExcel);

        // 创建自动滚动按钮
        const scrollButton = document.createElement('button');
        scrollButton.className = 'xhs-button';
        scrollButton.textContent = '自动滚动获取';
        scrollButton.addEventListener('click', toggleAutoScroll);

        // 创建"Powered by"元素
        const poweredBy = document.createElement('div');
        poweredBy.className = 'powered-by';
        poweredBy.innerHTML = 'Powered by <a href="http://inhai.wiki" target="_blank">@AI产品银海</a>';

        container.appendChild(counter);
        container.appendChild(exportButton);
        container.appendChild(scrollButton);
        container.appendChild(poweredBy);
        document.body.appendChild(container);
    }

    // 自动滚动相关变量和函数
    let isAutoScrolling = false;
    let scrollInterval;

    function toggleAutoScroll() {
        const scrollButton = document.querySelector('.xhs-button:last-child');
        if (isAutoScrolling) {
            stopAutoScroll();
            scrollButton.textContent = '自动滚动获取';
            scrollButton.style.background = 'linear-gradient(135deg, #ff2442 0%, #ff4d64 100%)';
        } else {
            startAutoScroll();
            scrollButton.textContent = '停止滚动';
            scrollButton.style.background = 'linear-gradient(135deg, #666 0%, #888 100%)';
        }
        isAutoScrolling = !isAutoScrolling;
    }

    function startAutoScroll() {
        scrollInterval = setInterval(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
        }, 1000);
    }

    function stopAutoScroll() {
        if (scrollInterval) {
            clearInterval(scrollInterval);
        }
    }

    // 拦截 XHR 请求
    function interceptXHR() {
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            if (url.includes('api/sns/web/v2/note/collect/page')) {
                this.addEventListener('load', function() {
                    try {
                        const response = JSON.parse(this.responseText);
                        if (response.success && response.data && response.data.notes) {
                            processNotes(response.data.notes);
                        }
                    } catch (error) {
                        console.error('解析响应数据失败:', error);
                    }
                });
            }
            return originalOpen.apply(this, arguments);
        };
    }

    // 拦截 Fetch 请求
    function interceptFetch() {
        const originalFetch = window.fetch;
        window.fetch = async function(url, options) {
            const response = await originalFetch.apply(this, arguments);
            if (url.toString().includes('api/sns/web/v2/note/collect/page')) {
                response.clone().json().then(data => {
                    if (data.success && data.data && data.data.notes) {
                        processNotes(data.data.notes);
                    }
                }).catch(error => {
                    console.error('解析Fetch响应数据失败:', error);
                });
            }
            return response;
        };
    }

    // 处理笔记数据
    function processNotes(notes) {
        const counter = document.getElementById('note-counter');
        notes.forEach(note => {
            const processedNote = {
                note_id: note.note_id || 'Unknown',
                xsec_token: note.xsec_token || 'Unknown',
                display_title: note.display_title || 'Unknown',
                user_id: note.user?.user_id || 'Unknown',
                nickname: note.user?.nickname || 'Unknown',
                avatar: note.user?.avatar || 'Unknown',
                liked_count: note.interact_info?.liked_count || 'Unknown',
                liked: note.interact_info?.liked === true ? '是' : note.interact_info?.liked === false ? '否' : 'Unknown',
                cover_url_pre: note.cover?.url_pre || 'Unknown',
                cover_url_default: note.cover?.url_default || 'Unknown',
                request_url: `https://www.xiaohongshu.com/explore/${note.note_id}?xsec_token=${note.xsec_token}&xsec_source=pc_user`
            };
            // 避免重复添加
            if (!collectedNotes.some(n => n.note_id === processedNote.note_id)) {
                collectedNotes.push(processedNote);
            }
        });
        // 更新计数器
        counter.textContent = `已获取笔记：${collectedNotes.length}`;
    }

    // 导出为Excel
    function exportToExcel() {
        if (collectedNotes.length === 0) {
            alert('暂未获取到收藏数据，请先浏览收藏夹页面');
            return;
        }

        const worksheet = XLSX.utils.json_to_sheet(collectedNotes);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "收藏夹");

        // 设置列宽
        const columnWidths = [
            {wch: 30}, // note_id
            {wch: 50}, // xsec_token
            {wch: 40}, // display_title
            {wch: 30}, // user_id
            {wch: 15}, // nickname
            {wch: 50}, // avatar
            {wch: 10}, // liked_count
            {wch: 10}, // liked
            {wch: 50}, // cover_url_pre
            {wch: 50}, // cover_url_default
            {wch: 100} // request_url
        ];
        worksheet['!cols'] = columnWidths;

        // 导出文件
        const fileName = `小红书收藏夹_${new Date().toLocaleDateString()}.xlsx`;
        XLSX.writeFile(workbook, fileName);
    }

    // 拖动相关功能
    function initDraggable(container) {
        let isDragging = false;
        let currentX;
        let currentY;
        let initialX;
        let initialY;
        let xOffset = 0;
        let yOffset = 0;

        // 从localStorage获取上次位置
        const savedPosition = localStorage.getItem('xhs-tool-position');
        if (savedPosition) {
            try {
                const { x, y } = JSON.parse(savedPosition);
                container.style.right = 'auto';
                container.style.left = x + 'px';
                container.style.top = y + 'px';
                xOffset = x;
                yOffset = y;
            } catch (error) {
                console.error('恢复位置失败:', error);
            }
        }

        function dragStart(e) {
            if (e.target.tagName === 'BUTTON') return; // 不处理按钮的拖动

            const rect = container.getBoundingClientRect();
            xOffset = rect.left;
            yOffset = rect.top;
            
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;
            
            if (e.target === container || e.target.className === 'note-counter') {
                isDragging = true;
                container.classList.add('dragging');
            }
        }

        function dragEnd() {
            if (!isDragging) return;
            
            initialX = currentX;
            initialY = currentY;
            isDragging = false;
            container.classList.remove('dragging');

            // 添加吸附动画类
            container.classList.add('snapping');
            
            // 磁吸效果
            const rect = container.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const threshold = 100; // 磁吸触发距离
            const safeDistance = 20; // 安全边距

            // 计算目标位置
            let targetX = currentX;
            let targetY = currentY;

            // 只允许左右两边吸附
            if (rect.left < threshold) { // 左边缘
                targetX = safeDistance;
            } else if (rect.right > viewportWidth - threshold) { // 右边缘
                targetX = viewportWidth - rect.width - safeDistance;
            } else if (rect.left < viewportWidth / 2) { // 在左半边，强制吸附到左边
                targetX = safeDistance;
            } else { // 在右半边，强制吸附到右边
                targetX = viewportWidth - rect.width - safeDistance;
            }

            // 垂直方向保持原位置，只做边界检查
            if (currentY < safeDistance) {
                targetY = safeDistance;
            } else if (currentY > viewportHeight - rect.height - safeDistance) {
                targetY = viewportHeight - rect.height - safeDistance;
            }

            // 更新位置
            currentX = targetX;
            currentY = targetY;

            // 300ms后移除动画类
            setTimeout(() => {
                container.classList.remove('snapping');
            }, 300);

            // 保存位置到localStorage
            localStorage.setItem('xhs-tool-position', JSON.stringify({
                x: currentX,
                y: currentY
            }));

            setTranslate(currentX, currentY, container);
        }

        function drag(e) {
            if (!isDragging) return;

            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;

            // 边界检查
            const rect = container.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            const safeDistance = 20; // 安全边距
            if (currentX < safeDistance) currentX = safeDistance;
            if (currentY < safeDistance) currentY = safeDistance;
            if (currentX > viewportWidth - rect.width - safeDistance) {
                currentX = viewportWidth - rect.width - safeDistance;
            }
            if (currentY > viewportHeight - rect.height - safeDistance) {
                currentY = viewportHeight - rect.height - safeDistance;
            }

            xOffset = currentX;
            yOffset = currentY;

            // 拖动时不需要动画
            container.classList.remove('snapping');
            setTranslate(currentX, currentY, container);
        }

        function setTranslate(xPos, yPos, el) {
            el.style.left = `${xPos}px`;
            el.style.top = `${yPos}px`;
            el.style.right = 'auto';
        }

        container.addEventListener('mousedown', dragStart);
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);
    }

    // 初始化
    function init() {
        createUI();
        interceptXHR();
        interceptFetch();
        
        // 初始化拖动功能
        const container = document.querySelector('.xhs-tool-container');
        initDraggable(container);
        
        // 初始化主题
        updateTheme(container, isDarkMode());
        initThemeListener(container);
    }

    // 等待页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
