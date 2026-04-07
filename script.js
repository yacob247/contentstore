        import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
        import { getAuth, signInAnonymously, signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
        import { getFirestore, collection, onSnapshot, addDoc, serverTimestamp, deleteDoc, doc, updateDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
        import {
            buildFileShareHash,
            buildItemShareHash,
            buildShareUrl,
            createShareSlug,
            getEmbeddableVideoMeta,
            getFileShareSlug,
            getItemShareSlug,
            getPrimaryEmbeddableVideo,
            normalizeCategory,
            sanitizeShareSlug
        } from "./content-link-utils.js";

        let firebaseApp, db, auth, currentTab = 'dashboard';
        let adminItems = [];
        let publicAdminItems = [];
        let sensitiveAdminItems = [];
        let adminInitPromise = null;
        let securityIncidents = [];
        const CATEGORY_INFO = {
            collection: { label: 'Collections (Mixed)', icon: 'fa-layer-group', color: 'text-purple-400' },
            document: { label: 'Texts & Documents', icon: 'fa-book', color: 'text-orange-400' },
            video: { label: 'Movies & Video', icon: 'fa-clapperboard', color: 'text-red-400' },
            audio: { label: 'Audio & Music', icon: 'fa-music', color: 'text-pink-400' },
            image: { label: 'Images & Photos', icon: 'fa-image', color: 'text-green-400' },
            software: { label: 'Software & Apps', icon: 'fa-box-archive', color: 'text-cyan-400' },
            archive: { label: 'Archives', icon: 'fa-file-zipper', color: 'text-yellow-400' },
            other: { label: 'Misc / Other', icon: 'fa-file-lines', color: 'text-gray-400' }
        };
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'infinite-nexus-v1';
        function isLoopbackHostname(hostname) {
            return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
        }

        function resolveSecurityBackendBaseUrl() {
            if (typeof __security_backend_url !== 'undefined' && __security_backend_url) {
                return __security_backend_url;
            }

            if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
                if (isLoopbackHostname(window.location.hostname)) {
                    return `${window.location.protocol}//${window.location.hostname}:8787`;
                }

                return window.location.origin;
            }

            return 'http://127.0.0.1:8787';
        }

        const SECURITY_BACKEND_BASE_URL = resolveSecurityBackendBaseUrl().replace(/\/+$/, '');
        const SECURITY_ADMIN_TOKEN = typeof __security_admin_token !== 'undefined' ? __security_admin_token : '';

        const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
          apiKey: "AIzaSyB-3kAk-lMT3jTny2YIs2R1_0mG-tJlmJI",
          authDomain: "puzzlesapp.firebaseapp.com",
          databaseURL: "https://puzzlesapp-default-rtdb.firebaseio.com",
          projectId: "puzzlesapp",
          storageBucket: "puzzlesapp.firebasestorage.app",
          messagingSenderId: "303461259730",
          appId: "1:303461259730:web:a1790a976b6d58d71dd00b",
          measurementId: "G-8YEJEBX0NE"
        };

        function ensureFirebaseClients() {
            if (!firebaseApp) {
                firebaseApp = initializeApp(firebaseConfig);
                auth = getAuth(firebaseApp);
                db = getFirestore(firebaseApp);
            }

            return { firebaseApp, auth, db };
        }

        // --- Core UI Utilities ---
        window.showToast = (message, type = 'success') => {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            const color = type === 'success' ? 'bg-green-600' : type === 'warning' ? 'bg-yellow-600' : 'bg-red-600';
            toast.className = `${color} text-white px-5 py-3 rounded-xl shadow-2xl flex items-center gap-3 transform transition-all duration-300 translate-y-10 opacity-0 pointer-events-auto border border-white/10`;
            toast.innerHTML = `<span class="font-medium text-sm">${message}</span>`;
            container.appendChild(toast);
            setTimeout(() => toast.classList.remove('translate-y-10', 'opacity-0'), 10);
            setTimeout(() => {
                toast.classList.add('translate-y-10', 'opacity-0');
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        };

        window.openModal = (htmlContent) => {
            const modal = document.getElementById('modal-container');
            modal.innerHTML = htmlContent;
            modal.classList.remove('hidden');
            setTimeout(() => modal.classList.remove('opacity-0'), 10);
        };

        window.closeModal = () => {
            const modal = document.getElementById('modal-container');
            modal.classList.add('opacity-0');
            setTimeout(() => { modal.classList.add('hidden'); modal.innerHTML = ''; }, 300);
        };

        function normalizeAdminItemRecord(rawItem, origin = 'firestore') {
            return {
                ...rawItem,
                category: normalizeCategory(rawItem.category),
                visibility: rawItem.visibility === 'sensitive' || origin === 'backend_sensitive' ? 'sensitive' : 'public',
                storageOrigin: origin,
                files: (rawItem.files || []).map(file => ({
                    ...file,
                    type: normalizeCategory(file.type || rawItem.category)
                }))
            };
        }

        function getSortableTimestampValue(value) {
            if (!value) return 0;
            if (typeof value?.toMillis === 'function') return value.toMillis();
            const parsed = Date.parse(value);
            return Number.isNaN(parsed) ? 0 : parsed;
        }

        function isSensitiveItem(item) {
            return item?.visibility === 'sensitive' || item?.storageOrigin === 'backend_sensitive';
        }

        function syncAdminItems() {
            adminItems = [...publicAdminItems, ...sensitiveAdminItems];
            if (currentTab === 'dashboard') renderDashboard();
        }

        function showWorkspaceShell() {
            const overlay = document.getElementById('auth-overlay');
            const workspace = document.getElementById('workspace');

            if (overlay) {
                overlay.classList.add('hidden');
            }

            if (workspace) {
                workspace.classList.remove('hidden');
                workspace.classList.add('flex');
            }
        }

        function showWorkspaceLoading(message = 'Connecting to secure backend...') {
            showWorkspaceShell();
            document.getElementById('main-content').innerHTML = `
                <div class="flex justify-center items-center h-64 flex-col fade-in">
                    <i class="fa-solid fa-circle-notch fa-spin text-4xl text-blue-500 mb-4"></i>
                    <p class="text-gray-400 font-medium">${escapeHtml(message)}</p>
                </div>`;
        }

        function renderAdminBootstrapError(message) {
            showWorkspaceShell();
            document.getElementById('main-content').innerHTML = `
                <div class="glass-card max-w-3xl mx-auto rounded-[2.5rem] p-10 text-center border border-red-500/20 shadow-2xl fade-in">
                    <div class="w-20 h-20 mx-auto mb-6 rounded-full border border-red-500/20 bg-red-500/10 flex items-center justify-center">
                        <i class="fa-solid fa-shield-halved text-4xl text-red-400"></i>
                    </div>
                    <p class="text-[11px] uppercase tracking-[0.35em] text-red-300/70 font-bold mb-4">Admin Console</p>
                    <h1 class="text-4xl font-extrabold tracking-tight mb-3">Console Not Ready</h1>
                    <p class="text-slate-400 leading-relaxed max-w-2xl mx-auto">${escapeHtml(message)}</p>
                </div>`;
        }

        async function ensureAdminBootstrapAuth() {
            ensureFirebaseClients();
            if (auth?.currentUser) {
                return auth.currentUser;
            }

            await signInAnonymously(auth);
            return auth.currentUser;
        }

        async function getAdminRequestHeaders(includeJson = false) {
            const headers = {};
            if (includeJson) {
                headers['Content-Type'] = 'application/json';
            }
            if (SECURITY_ADMIN_TOKEN) {
                headers['x-security-admin-token'] = SECURITY_ADMIN_TOKEN;
            }
            if (auth?.currentUser) {
                headers.Authorization = `Bearer ${await auth.currentUser.getIdToken()}`;
            }

            return headers;
        }

        async function requestAdminSession(path, method, body) {
            let response = null;
            try {
                const headers = await getAdminRequestHeaders(Boolean(body));
                response = await fetch(buildSecurityBackendUrl(path), {
                    method,
                    credentials: 'include',
                    headers: Object.keys(headers).length ? headers : undefined,
                    body: body ? JSON.stringify(body) : undefined
                });
            } catch (error) {
                throw new Error('Cannot access.');
            }

            let payload = null;
            try {
                payload = await response.json();
            } catch (error) {
                payload = null;
            }

            if (!response.ok) {
                throw new Error(payload?.error || 'Cannot access.');
            }

            return payload;
        }

        async function assertAdminAccess() {
            const payload = await requestAdminSession('/api/admin/session', 'GET');
            if (!payload?.authenticated) {
                throw new Error('Cannot access.');
            }
            return payload;
        }

        async function bootstrapAdminConsole() {
            try {
                showWorkspaceLoading('Opening admin console...');
                await ensureAdminBootstrapAuth();
                await assertAdminAccess();
                await init();
            } catch (error) {
                console.error('Admin console bootstrap failed', error);
                renderAdminBootstrapError('The console could not finish loading. If you want Cloudflare IP-only access, clear ADMIN_DASHBOARD_PASSWORD and SECURITY_ADMIN_TOKEN on the live backend, and disable any FIREBASE_ADMIN_* admin gate that still expects a signed-in operator, then reload this page.');
            }
        }

        // --- Initialization ---
        window.lockConsole = async () => {
            try {
                ensureFirebaseClients();
                if (auth?.currentUser) {
                    await signOut(auth);
                }
            } catch (error) {
                console.error('Admin session clear failed', error);
            }

            location.reload();
        };

        async function init() {
            if (adminInitPromise) {
                await adminInitPromise;
                return;
            }

            adminInitPromise = (async () => {
                ensureFirebaseClients();
                if (!auth?.currentUser) {
                    throw new Error('Could not start the admin session.');
                }

                const q = collection(db, 'artifacts', appId, 'public', 'data', 'content_hub_items');
                onSnapshot(q, snap => {
                    publicAdminItems = snap.docs.map(d => normalizeAdminItemRecord({ id: d.id, ...d.data() }, 'firestore'));
                    syncAdminItems();
                }, err => {
                    console.error(err);
                    showToast("Failed to sync realtime data.", "error");
                });

                await refreshSensitiveItems();
                await refreshSecurityIncidents();
                setTab('dashboard');
            })();

            try {
                await adminInitPromise;
            } catch (error) {
                adminInitPromise = null;
                throw error;
            }
        }

        window.setTab = (tab) => {
            currentTab = tab;
            const dashBtn = document.getElementById('tab-dash');
            if(tab === 'dashboard') dashBtn.classList.replace('text-gray-400', 'text-blue-400');
            else dashBtn.classList.replace('text-blue-400', 'text-gray-400');
            
            if (tab === 'dashboard') renderDashboard();
            else renderUpload();
        }

        function buildSecurityBackendUrl(path) {
            return `${SECURITY_BACKEND_BASE_URL}${path}`;
        }

        function getCategoryInfo(category) {
            return CATEGORY_INFO[normalizeCategory(category)] || CATEGORY_INFO.other;
        }

        function getPublicAppBaseUrl() {
            const url = new URL(window.location.href);
            url.hash = '';
            url.search = '';
            if (/\/[^/]+\.html$/i.test(url.pathname)) {
                url.pathname = url.pathname.replace(/\/[^/]+\.html$/i, '/index.html');
            } else if (url.pathname.endsWith('/')) {
                url.pathname = `${url.pathname}index.html`;
            }
            return url.toString();
        }

        function buildItemShareUrl(item) {
            return buildShareUrl(getPublicAppBaseUrl(), buildItemShareHash(getItemShareSlug(item)));
        }

        function buildFileShareUrl(item, file, index) {
            return buildShareUrl(
                getPublicAppBaseUrl(),
                buildFileShareHash(getItemShareSlug(item), getFileShareSlug(item, file, index))
            );
        }

        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function getSecurityBackendReportUrl(scanId) {
            return buildSecurityBackendUrl(`/api/uploads/report/${scanId}`);
        }

        function getSecurityBackendFileUrl(scanId) {
            return buildSecurityBackendUrl(`/api/uploads/${scanId}/file`);
        }

        function getSecurityBackendDownloadUrl(downloadId) {
            return buildSecurityBackendUrl(`/api/downloads/${downloadId}`);
        }

        function resolveSecurityBackendDownloadUrl(reportOrScan) {
            const downloadId = reportOrScan?.downloadId || reportOrScan?.links?.downloadId || reportOrScan?.id;
            if (reportOrScan?.downloadPath) {
                return buildSecurityBackendUrl(reportOrScan.downloadPath);
            }
            return getSecurityBackendDownloadUrl(downloadId);
        }

        async function copyTextToClipboard(text, successMessage) {
            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                } else {
                    const field = document.createElement('textarea');
                    field.value = text;
                    field.setAttribute('readonly', '');
                    field.style.position = 'absolute';
                    field.style.left = '-9999px';
                    document.body.appendChild(field);
                    field.select();
                    document.execCommand('copy');
                    field.remove();
                }
                showToast(successMessage || 'Link copied.');
            } catch (error) {
                showToast('Could not copy the link automatically.', 'error');
            }
        }

        function getItemById(id) {
            return adminItems.find(i => i.id === id) || null;
        }

        window.copyItemShareLinkById = async (id) => {
            const item = getItemById(id);
            if (!item) return;
            await copyTextToClipboard(buildItemShareUrl(item), "Item link copied.");
        };

        window.copyFileShareLinkById = async (id, fileShareSlug) => {
            const item = getItemById(id);
            if (!item) return;

            const files = item.files || [];
            const match = files.findIndex((file, index) => getFileShareSlug(item, file, index) === fileShareSlug);
            if (match === -1) return;

            const targetFile = files[match];
            const videoMeta = getEmbeddableVideoMeta(targetFile);
            const linkToCopy = videoMeta
                ? buildFileShareUrl(item, targetFile, match)
                : (targetFile?.url || buildFileShareUrl(item, targetFile, match));

            await copyTextToClipboard(linkToCopy, videoMeta ? "Video link copied." : "Download link copied.");
        };

        window.openPublicItem = (id) => {
            const item = getItemById(id);
            if (!item) return;
            window.open(buildItemShareUrl(item), '_blank', 'noopener,noreferrer');
        };

        window.previewVideoItem = (id, fileShareSlug = '') => {
            const item = getItemById(id);
            if (!item) return;

            const files = item.files || [];
            let matchIndex = fileShareSlug
                ? files.findIndex((file, index) => getFileShareSlug(item, file, index) === fileShareSlug)
                : -1;

            if (matchIndex === -1) {
                const primary = getPrimaryEmbeddableVideo(item);
                if (!primary) {
                    showToast("No embeddable YouTube file is attached to this item.", "error");
                    return;
                }
                matchIndex = primary.index;
                fileShareSlug = primary.shareSlug;
            }

            const file = files[matchIndex];
            const video = getEmbeddableVideoMeta(file);
            if (!video) {
                showToast("That file is not an embeddable YouTube video.", "error");
                return;
            }

            openModal(`
                <div class="glass-card p-6 rounded-[2.5rem] w-full max-w-5xl border border-red-500/20 shadow-2xl relative fade-in overflow-hidden">
                    <button onclick="closeModal()" class="absolute top-5 right-5 text-gray-500 hover:text-white transition"><i class="fa-solid fa-times text-xl"></i></button>
                    <div class="pr-14 mb-5">
                        <div class="flex items-center gap-3 mb-2">
                            <div class="w-11 h-11 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
                                <i class="fa-brands fa-youtube text-xl"></i>
                            </div>
                            <div>
                                <h3 class="text-2xl font-bold text-white">${escapeHtml(file.name || item.title || 'Video Preview')}</h3>
                                <p class="text-xs uppercase tracking-[0.2em] text-gray-500">${escapeHtml(item.title || 'Content Store')}</p>
                            </div>
                        </div>
                        <div class="flex flex-wrap gap-2 text-xs">
                            <button onclick="copyFileShareLinkById('${item.id}', '${fileShareSlug}')" class="px-3 py-2 rounded-xl border border-gray-700 bg-gray-900 hover:bg-gray-800 text-white font-bold transition"><i class="fa-solid fa-link mr-2"></i>Copy File Link</button>
                            <button onclick="copyItemShareLinkById('${item.id}')" class="px-3 py-2 rounded-xl border border-gray-700 bg-gray-900 hover:bg-gray-800 text-white font-bold transition"><i class="fa-solid fa-folder-open mr-2"></i>Copy Item Link</button>
                            <a href="${video.watchUrl}" target="_blank" rel="noopener noreferrer" class="px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold transition"><i class="fa-brands fa-youtube mr-2"></i>Open on YouTube</a>
                        </div>
                    </div>
                    <div class="relative w-full rounded-[2rem] overflow-hidden bg-black border border-gray-800" style="padding-top: 56.25%;">
                        <iframe class="absolute inset-0 w-full h-full" src="${video.embedUrl}" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" frameborder="0" allowfullscreen></iframe>
                    </div>
                </div>
            `);
        };

        function collectBackendScanIds(item) {
            const entries = [];

            if (item?.imageScan?.id) {
                entries.push({ scanId: item.imageScan.id, label: 'Cover image' });
            }

            (item?.files || []).forEach((file, index) => {
                if (file?.backendScan?.id) {
                    entries.push({
                        scanId: file.backendScan.id,
                        label: file.name || `File ${index + 1}`
                    });
                }
            });

            return entries;
        }

        async function callSecurityBackend(path, method, body) {
            let response = null;
            try {
                const headers = await getAdminRequestHeaders(true);
                response = await fetch(buildSecurityBackendUrl(path), {
                    method,
                    credentials: 'include',
                    headers,
                    body: body ? JSON.stringify(body) : undefined
                });
            } catch (error) {
                throw new Error('Cannot access.');
            }

            let payload = null;
            try {
                payload = await response.json();
            } catch (error) {
                payload = null;
            }

            if (!response.ok) {
                throw new Error(payload?.error || `Security backend request failed (${response.status}).`);
            }

            return payload;
        }

        async function refreshSensitiveItems() {
            try {
                const payload = await callSecurityBackend('/api/private/items', 'GET');
                sensitiveAdminItems = (payload?.items || []).map(item => normalizeAdminItemRecord(item, 'backend_sensitive'));
                syncAdminItems();
            } catch (error) {
                console.error('Failed to load sensitive items', error);
                sensitiveAdminItems = [];
                syncAdminItems();
            }
        }

        async function createSensitiveBackendItem(payload) {
            const response = await callSecurityBackend('/api/private/items', 'POST', payload);
            return normalizeAdminItemRecord(response?.item || {}, 'backend_sensitive');
        }

        async function updateSensitiveBackendItem(itemId, payload) {
            const response = await callSecurityBackend(`/api/private/items/${itemId}`, 'PUT', payload);
            return normalizeAdminItemRecord(response?.item || {}, 'backend_sensitive');
        }

        async function deleteSensitiveBackendItem(itemId) {
            return callSecurityBackend(`/api/private/items/${itemId}`, 'DELETE');
        }

        async function refreshSecurityIncidents() {
            try {
                const payload = await callSecurityBackend('/api/incidents', 'GET');
                securityIncidents = payload?.incidents || [];
                if (currentTab === 'dashboard') renderDashboard();
            } catch (error) {
                console.error('Failed to load security incidents', error);
            }
        }
        window.refreshSecurityIncidents = refreshSecurityIncidents;

        function getIncidentById(id) {
            return securityIncidents.find(incident => incident.id === id) || null;
        }

        function getIncidentHeadline(incident) {
            return incident?.analysis?.summary || incident?.findings?.[0]?.reason || 'Blocked upload incident';
        }

        function getIncidentStatusBadge(status) {
            const normalized = String(status || 'open').toLowerCase();
            if (normalized === 'contained') return `<span class="px-3 py-1 text-[10px] rounded-full font-bold uppercase bg-green-500/10 text-green-400 border border-green-500/20">Contained</span>`;
            if (normalized === 'mitigated') return `<span class="px-3 py-1 text-[10px] rounded-full font-bold uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20">Mitigated</span>`;
            if (normalized === 'awaiting_resubmission') return `<span class="px-3 py-1 text-[10px] rounded-full font-bold uppercase bg-purple-500/10 text-purple-400 border border-purple-500/20">Awaiting Resubmission</span>`;
            if (normalized === 'escalated') return `<span class="px-3 py-1 text-[10px] rounded-full font-bold uppercase bg-orange-500/10 text-orange-400 border border-orange-500/20">Escalated</span>`;
            if (normalized === 'under_review') return `<span class="px-3 py-1 text-[10px] rounded-full font-bold uppercase bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">Under Review</span>`;
            return `<span class="px-3 py-1 text-[10px] rounded-full font-bold uppercase bg-red-500/10 text-red-400 border border-red-500/20">Open</span>`;
        }

        async function fetchIncidentDetail(id) {
            const payload = await callSecurityBackend(`/api/incidents/${id}`, 'GET');
            return payload?.incident || null;
        }

        function buildBackendScanMetaFromReport(report) {
            if (!report?.id) return null;
            const downloadId = report?.links?.downloadId || report?.downloadId || report.id;
            return {
                id: report.id,
                downloadId,
                status: report.status,
                verdict: report.verdict,
                reportUrl: getSecurityBackendReportUrl(report.id),
                fileUrl: getSecurityBackendFileUrl(report.id),
                downloadUrl: resolveSecurityBackendDownloadUrl(report),
                findings: (report.findings || []).map(finding => ({
                    kind: finding.kind || '',
                    severity: finding.severity || '',
                    reason: finding.reason || ''
                }))
            };
        }

        async function uploadToSecurityBackend(file, metadata, updateStatusFn) {
            const formData = new FormData();
            formData.append('file', file, file.name);

            Object.entries(metadata || {}).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') formData.append(key, value);
            });

            return await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', buildSecurityBackendUrl('/api/uploads/scan'));
                xhr.withCredentials = true;
                if (SECURITY_ADMIN_TOKEN) {
                    xhr.setRequestHeader('x-security-admin-token', SECURITY_ADMIN_TOKEN);
                }
                const attachHeaders = async () => {
                    if (auth?.currentUser) {
                        const token = await auth.currentUser.getIdToken();
                        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
                    }
                };

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const percent = 10 + ((e.loaded / e.total) * 75);
                        const mbLoaded = Math.round((e.loaded / 1024 / 1024) * 10) / 10;
                        const mbTotal = Math.round((e.total / 1024 / 1024) * 10) / 10;
                        updateStatusFn(percent, `Sending to security backend: ${mbLoaded}MB / ${mbTotal}MB`);
                    }
                };

                xhr.onload = () => {
                    let payload = null;
                    try {
                        payload = JSON.parse(xhr.responseText || '{}');
                    } catch (error) {
                        payload = null;
                    }

                    if (xhr.status >= 200 && xhr.status < 300 && payload) {
                        resolve(payload);
                        return;
                    }

                    const detailedReason = payload?.findings?.find(f => f.reason)?.reason || payload?.error || `Security backend rejected the upload (${xhr.status}).`;
                    reject(new Error(detailedReason));
                };

                xhr.onerror = () => reject(new Error("Could not reach the security backend."));
                attachHeaders()
                    .then(() => xhr.send(formData))
                    .catch(() => reject(new Error('Cannot access.')));
            });
        }

        async function releaseItemSecurityAssets(item) {
            const scans = collectBackendScanIds(item);
            for (const scan of scans) {
                await callSecurityBackend(`/api/uploads/${scan.scanId}/release`, 'POST', { actor: 'admin-panel' });
            }
            return scans.length;
        }

        async function rejectItemSecurityAssets(item) {
            const scans = collectBackendScanIds(item);
            for (const scan of scans) {
                await callSecurityBackend(`/api/uploads/${scan.scanId}/reject`, 'POST', {
                    actor: 'admin-panel',
                    reason: 'Rejected by admin moderation'
                });
            }
            return scans.length;
        }

        // --- Admin Controls & Data Management ---
        window.updateStatus = async (id, status) => {
            try {
                const item = getItemById(id);
                if (!item) throw new Error("Item not found.");

                if (status === 'approved') {
                    const releasedCount = await releaseItemSecurityAssets(item);
                    if (isSensitiveItem(item)) {
                        await updateSensitiveBackendItem(id, { status });
                        await refreshSensitiveItems();
                    } else {
                        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', id), { status });
                    }
                    await refreshSecurityIncidents();
                    showToast(releasedCount > 0 ? `Stream approved and ${releasedCount} quarantined asset(s) released.` : "Stream marked as approved.", 'success');
                    return;
                }

                if (status === 'rejected') {
                    const rejectedCount = await rejectItemSecurityAssets(item);
                    if (isSensitiveItem(item)) {
                        await updateSensitiveBackendItem(id, { status });
                        await refreshSensitiveItems();
                    } else {
                        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', id), { status });
                    }
                    await refreshSecurityIncidents();
                    showToast(rejectedCount > 0 ? `Stream rejected and ${rejectedCount} quarantined asset(s) were rejected in the backend.` : "Stream marked as rejected.", 'warning');
                    return;
                }

                if (isSensitiveItem(item)) {
                    await updateSensitiveBackendItem(id, { status });
                    await refreshSensitiveItems();
                } else {
                    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', id), { status });
                }
                showToast(`Stream marked as ${status}.`, status === 'approved' ? 'success' : 'warning');
            } catch (e) { showToast(e.message || "Error updating status.", "error"); }
        };

        window.removeItem = async (id) => {
            if(confirm("Permanently purge this asset from the Hub? It will be deleted for everyone.")) {
                try {
                    const item = getItemById(id);
                    if (!item) throw new Error("Item not found.");

                    if (isSensitiveItem(item)) {
                        await deleteSensitiveBackendItem(id);
                        await refreshSensitiveItems();
                    } else {
                        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', id));
                    }
                    showToast("Asset purged successfully.");
                } catch(e) { showToast("Failed to delete.", "error"); }
            }
        };

        window.editItem = (id) => {
            const item = adminItems.find(i => i.id === id);
            if (!item) return;

            const primaryVideo = getPrimaryEmbeddableVideo(item);
            const rawJson = escapeHtml(JSON.stringify({
                ...item,
                createdAt: undefined,
                updatedAt: undefined,
                category: normalizeCategory(item.category),
                visibility: isSensitiveItem(item) ? 'sensitive' : 'public',
                shareSlug: getItemShareSlug(item),
                files: (item.files || []).map((file, index) => ({
                    ...file,
                    type: normalizeCategory(file.type || item.category),
                    shareSlug: getFileShareSlug(item, file, index)
                }))
            }, null, 2));

            openModal(`
                <div class="glass-card p-8 rounded-[2.5rem] w-full max-w-5xl border border-blue-500/20 shadow-2xl relative fade-in max-h-[92vh] overflow-y-auto">
                    <button onclick="closeModal()" class="absolute top-6 right-6 text-gray-500 hover:text-white transition"><i class="fa-solid fa-times text-xl"></i></button>
                    <div class="pr-12">
                        <div class="flex flex-wrap items-center gap-4 mb-6">
                            <div class="w-12 h-12 bg-blue-600/10 rounded-2xl flex items-center justify-center text-blue-500 border border-blue-500/20">
                                <i class="fa-solid fa-pen-to-square text-xl"></i>
                            </div>
                            <div>
                                <h3 class="text-2xl font-bold text-white">Full Item Control</h3>
                                <p class="text-xs uppercase tracking-[0.2em] text-gray-500">Structured controls plus raw document editing</p>
                            </div>
                        </div>

                        <div class="grid grid-cols-1 xl:grid-cols-[1.15fr_0.85fr] gap-6">
                            <div class="space-y-5">
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div class="group md:col-span-2">
                                        <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Title</label>
                                        <input type="text" id="edit-title" value="${escapeHtml(item.title || '')}" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-white focus:border-blue-500 outline-none transition">
                                    </div>

                                    <div class="group md:col-span-2">
                                        <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Description</label>
                                        <textarea id="edit-desc" rows="4" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-white focus:border-blue-500 outline-none transition">${escapeHtml(item.description || '')}</textarea>
                                    </div>

                                    <div class="group">
                                        <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Category</label>
                                        <select id="edit-cat" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-white focus:border-blue-500 outline-none transition">
                                            ${Object.entries(CATEGORY_INFO).map(([key, info]) => `
                                                <option value="${key}" ${normalizeCategory(item.category) === key ? 'selected' : ''}>${info.label}</option>
                                            `).join('')}
                                        </select>
                                    </div>

                                    <div class="group">
                                        <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Status</label>
                                        <select id="edit-status" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-white focus:border-blue-500 outline-none transition">
                                            <option value="approved" ${item.status === 'approved' ? 'selected' : ''}>Approved</option>
                                            <option value="pending" ${item.status === 'pending' ? 'selected' : ''}>Pending</option>
                                            <option value="rejected" ${item.status === 'rejected' ? 'selected' : ''}>Rejected</option>
                                        </select>
                                    </div>

                                    <div class="group md:col-span-2">
                                        <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Storage Mode</label>
                                        <div class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-sm text-gray-300">
                                            ${isSensitiveItem(item)
                                                ? '<span class="text-red-400 font-bold"><i class="fa-solid fa-user-shield mr-2"></i>Sensitive / Server Only</span><p class="text-xs text-gray-500 mt-2">This item is stored in the backend-only catalog and only resolves through the backend access layer.</p>'
                                                : '<span class="text-blue-400 font-bold"><i class="fa-solid fa-globe mr-2"></i>Public / Firestore</span><p class="text-xs text-gray-500 mt-2">This item is published through the public Firestore catalog and standard public routes.</p>'
                                            }
                                        </div>
                                    </div>
                                </div>

                                <div class="group bg-gray-900/50 p-5 rounded-2xl border border-gray-800">
                                    <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Public Item URL Slug</label>
                                    <input type="text" id="edit-share-slug" value="${escapeHtml(getItemShareSlug(item))}" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-white focus:border-blue-500 outline-none transition" placeholder="custom-item-url">
                                    <div class="flex flex-wrap gap-2 mt-3 text-xs">
                                        <button onclick="copyItemShareLinkById('${item.id}')" class="px-3 py-2 rounded-xl border border-gray-700 bg-gray-950 hover:bg-gray-900 text-white font-bold transition"><i class="fa-solid fa-link mr-2"></i>Copy Item Link</button>
                                        <button onclick="openPublicItem('${item.id}')" class="px-3 py-2 rounded-xl border border-gray-700 bg-gray-950 hover:bg-gray-900 text-white font-bold transition"><i class="fa-solid fa-up-right-from-square mr-2"></i>Open Public Page</button>
                                    </div>
                                </div>

                                <div class="group">
                                    <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Cover Image URL</label>
                                    ${item.imageScan?.id
                                        ? `<div class="bg-gray-950 border border-gray-800 rounded-2xl p-4 text-sm text-gray-300">
                                            <div class="flex items-center gap-2 text-amber-400 font-bold mb-2"><i class="fa-solid fa-file-shield"></i> Backend-managed cover image</div>
                                            <p class="text-xs text-gray-500 mb-3">This cover image is served by the security backend after release. To change the binary itself, use the user workspace upload path.</p>
                                            <input type="text" value="${escapeHtml(item.imageScan.reportUrl || '')}" readonly class="w-full bg-black/30 border border-gray-800 rounded-xl p-3 text-xs text-gray-400 outline-none">
                                          </div>`
                                        : `<input type="url" id="edit-img" value="${escapeHtml(item.imageUrl || '')}" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-white focus:border-blue-500 outline-none transition" placeholder="https://...">`
                                    }
                                </div>

                                <div class="group bg-gray-900/50 p-5 rounded-2xl border border-gray-800">
                                    <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-3 ml-1"><i class="fa-solid fa-sliders text-blue-500 mr-2"></i>File-Level Controls</label>
                                    <div class="space-y-4">
                                        ${(item.files || []).map((file, index) => {
                                            const fileShareSlug = getFileShareSlug(item, file, index);
                                            const fileType = normalizeCategory(file.type || item.category);
                                            const video = getEmbeddableVideoMeta(file);

                                            return `
                                                <div class="bg-gray-950 border border-gray-800 rounded-[1.75rem] p-4">
                                                    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
                                                        <div>
                                                            <div class="text-[10px] uppercase tracking-[0.2em] text-gray-600 mb-1">File ${index + 1}</div>
                                                            <div class="font-bold text-white">${escapeHtml(file.name || `File ${index + 1}`)}</div>
                                                        </div>
                                                        <div class="flex flex-wrap gap-2 text-xs">
                                                            <button onclick="copyFileShareLinkById('${item.id}', '${fileShareSlug}')" class="px-3 py-2 rounded-xl border border-gray-700 bg-gray-900 hover:bg-gray-800 text-white font-bold transition"><i class="fa-solid fa-link mr-2"></i>Copy Link</button>
                                                            ${video ? `<button onclick="previewVideoItem('${item.id}', '${fileShareSlug}')" class="px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold transition"><i class="fa-brands fa-youtube mr-2"></i>Preview</button>` : ''}
                                                            ${file.url ? `<a href="${file.url}" target="_blank" rel="noopener noreferrer" class="px-3 py-2 rounded-xl border border-gray-700 bg-gray-900 hover:bg-gray-800 text-white font-bold transition"><i class="fa-solid fa-up-right-from-square mr-2"></i>Open Source</a>` : ''}
                                                        </div>
                                                    </div>

                                                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                        <div>
                                                            <label class="block text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em] mb-2">File Name</label>
                                                            <input type="text" id="edit-file-name-${index}" value="${escapeHtml(file.name || '')}" class="w-full bg-black/40 border border-gray-800 rounded-xl p-3 text-white focus:border-blue-500 outline-none transition">
                                                        </div>
                                                        <div>
                                                            <label class="block text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em] mb-2">File Type</label>
                                                            <select id="edit-file-type-${index}" class="w-full bg-black/40 border border-gray-800 rounded-xl p-3 text-white focus:border-blue-500 outline-none transition">
                                                                ${Object.entries(CATEGORY_INFO).map(([key, info]) => `
                                                                    <option value="${key}" ${fileType === key ? 'selected' : ''}>${info.label}</option>
                                                                `).join('')}
                                                            </select>
                                                        </div>
                                                        <div class="md:col-span-2">
                                                            <label class="block text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em] mb-2">Public File URL Slug</label>
                                                            <input type="text" id="edit-file-share-slug-${index}" value="${escapeHtml(fileShareSlug)}" class="w-full bg-black/40 border border-gray-800 rounded-xl p-3 text-white focus:border-blue-500 outline-none transition">
                                                        </div>
                                                        <div class="md:col-span-2">
                                                            <label class="block text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em] mb-2">${file.backendScan?.id ? 'Backend File Source' : 'File URL'}</label>
                                                            ${file.backendScan?.id
                                                                ? `<div class="bg-black/30 border border-gray-800 rounded-xl p-4 text-sm text-gray-300">
                                                                    <div class="text-amber-400 text-xs font-bold mb-2"><i class="fa-solid fa-file-shield mr-1"></i>Backend-managed file</div>
                                                                    <div class="text-xs text-gray-500 break-all">${escapeHtml(file.backendScan.reportUrl || file.url || '')}</div>
                                                                  </div>`
                                                                : `<input type="text" id="edit-file-url-${index}" value="${escapeHtml(file.url || '')}" class="w-full bg-black/40 border border-gray-800 rounded-xl p-3 text-white focus:border-blue-500 outline-none transition" placeholder="https://...">`
                                                            }
                                                        </div>
                                                    </div>
                                                </div>
                                            `;
                                        }).join('') || `<p class="text-xs text-gray-600 italic">No files are attached to this node.</p>`}
                                    </div>
                                </div>
                            </div>

                            <div class="space-y-5">
                                ${primaryVideo ? `
                                    <div class="bg-gray-900/60 border border-red-500/10 rounded-[2rem] p-5">
                                        <div class="flex items-center justify-between gap-3 mb-4">
                                            <div>
                                                <div class="text-[10px] uppercase tracking-[0.2em] text-gray-500 mb-1">Video Preview</div>
                                                <div class="font-bold text-white">${escapeHtml(primaryVideo.file.name || item.title || 'Embeddable video')}</div>
                                            </div>
                                            <button onclick="previewVideoItem('${item.id}', '${primaryVideo.shareSlug}')" class="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold transition">Open Preview</button>
                                        </div>
                                        <div class="relative w-full rounded-[1.5rem] overflow-hidden bg-black border border-gray-800" style="padding-top: 56.25%;">
                                            <iframe class="absolute inset-0 w-full h-full" src="${primaryVideo.embedUrl}" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" frameborder="0" allowfullscreen></iframe>
                                        </div>
                                    </div>
                                ` : ''}

                                <div class="bg-gray-900/50 p-5 rounded-[2rem] border border-gray-800">
                                    <div class="flex items-center gap-3 mb-3">
                                        <div class="w-10 h-10 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
                                            <i class="fa-solid fa-code"></i>
                                        </div>
                                        <div>
                                            <div class="font-bold text-white">Raw Document JSON</div>
                                            <div class="text-xs text-gray-500">Use this when you want control over every field or extra metadata key.</div>
                                        </div>
                                    </div>
                                    <textarea id="edit-raw-json" rows="22" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-xs font-mono text-gray-200 focus:border-blue-500 outline-none transition">${rawJson}</textarea>
                                    <p class="text-[11px] text-gray-500 mt-3">Saving raw JSON overwrites the core document fields and merges any additional keys you include.</p>
                                </div>
                            </div>
                        </div>

                        <div class="flex flex-wrap gap-3 pt-6 mt-6 border-t border-gray-800">
                            <button onclick="closeModal()" class="bg-gray-900 hover:bg-gray-800 border border-gray-800 text-white font-bold py-4 px-6 rounded-2xl transition">Cancel</button>
                            <button onclick="saveRawEdit('${id}')" class="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-4 px-6 rounded-2xl transition shadow-lg">Save Raw JSON</button>
                            <button onclick="saveEdit('${id}')" class="btn-gradient text-white font-bold py-4 px-6 rounded-2xl transition shadow-lg">Save Structured Changes</button>
                        </div>
                    </div>
                </div>
            `);
        };

        window.saveEdit = async (id) => {
            const item = adminItems.find(i => i.id === id);
            if (!item) return;

            const title = document.getElementById('edit-title').value.trim();
            const description = document.getElementById('edit-desc').value.trim();
            const category = normalizeCategory(document.getElementById('edit-cat').value);
            const status = document.getElementById('edit-status').value;
            const shareSlug = sanitizeShareSlug(document.getElementById('edit-share-slug').value.trim() || getItemShareSlug(item), 'item');
            const imageUrlInput = document.getElementById('edit-img');
            const imageUrl = imageUrlInput ? imageUrlInput.value.trim() : (item.imageUrl || '');

            const updatedFiles = (item.files || []).map((file, index) => {
                const updated = { ...file };
                const nameInput = document.getElementById(`edit-file-name-${index}`);
                const typeInput = document.getElementById(`edit-file-type-${index}`);
                const shareInput = document.getElementById(`edit-file-share-slug-${index}`);
                const urlInput = document.getElementById(`edit-file-url-${index}`);

                updated.name = nameInput ? nameInput.value.trim() || updated.name || `File ${index + 1}` : updated.name;
                updated.type = normalizeCategory(typeInput?.value || updated.type || category);
                updated.shareSlug = sanitizeShareSlug(shareInput?.value?.trim() || getFileShareSlug(item, file, index), 'file');

                if (urlInput) {
                    updated.url = urlInput.value.trim();
                }

                return updated;
            });

            try {
                if (item.status !== status) {
                    if (status === 'approved') {
                        await releaseItemSecurityAssets(item);
                    } else if (status === 'rejected') {
                        await rejectItemSecurityAssets(item);
                    }
                }

                const payload = {
                    title,
                    description,
                    category,
                    status,
                    shareSlug,
                    imageUrl,
                    visibility: isSensitiveItem(item) ? 'sensitive' : 'public',
                    files: updatedFiles
                };

                if (isSensitiveItem(item)) {
                    await updateSensitiveBackendItem(id, payload);
                    await refreshSensitiveItems();
                } else {
                    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', id), {
                        ...payload,
                        updatedAt: serverTimestamp()
                    });
                }
                if (item.status !== status) {
                    await refreshSecurityIncidents();
                }
                showToast("Structured metadata, routes, and file controls updated.");
                closeModal();
            } catch (e) { showToast("Failed to update data.", "error"); }
        };

        window.saveRawEdit = async (id) => {
            const item = adminItems.find(i => i.id === id);
            if (!item) return;

            const rawText = document.getElementById('edit-raw-json').value.trim();
            if (!rawText) {
                showToast("Raw JSON is empty.", "error");
                return;
            }

            try {
                const parsed = JSON.parse(rawText);
                if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
                    throw new Error("Raw JSON must describe an object.");
                }

                delete parsed.id;

                const rawCategory = normalizeCategory(parsed.category || item.category);
                const payload = {
                    ...parsed,
                    title: parsed.title ?? item.title ?? '',
                    description: parsed.description ?? item.description ?? '',
                    category: rawCategory,
                    status: parsed.status ?? item.status ?? 'approved',
                    visibility: isSensitiveItem(item) ? 'sensitive' : 'public',
                    shareSlug: sanitizeShareSlug(parsed.shareSlug || getItemShareSlug(item), 'item'),
                    imageUrl: parsed.imageUrl ?? item.imageUrl ?? '',
                    imageScan: parsed.imageScan ?? item.imageScan ?? null,
                    submitterEmail: parsed.submitterEmail ?? item.submitterEmail ?? '',
                    submitterUid: parsed.submitterUid ?? item.submitterUid ?? '',
                    folderId: parsed.folderId ?? item.folderId ?? null,
                    files: Array.isArray(parsed.files)
                        ? parsed.files.map((file, index) => ({
                            ...file,
                            name: file?.name || `File ${index + 1}`,
                            type: normalizeCategory(file?.type || rawCategory),
                            shareSlug: sanitizeShareSlug(file?.shareSlug || getFileShareSlug(item, file, index), 'file')
                        }))
                        : (item.files || [])
                };

                if (item.status !== payload.status) {
                    if (payload.status === 'approved') {
                        await releaseItemSecurityAssets(item);
                    } else if (payload.status === 'rejected') {
                        await rejectItemSecurityAssets(item);
                    }
                }

                if (isSensitiveItem(item)) {
                    await updateSensitiveBackendItem(id, payload);
                    await refreshSensitiveItems();
                } else {
                    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', id), {
                        ...payload,
                        updatedAt: serverTimestamp()
                    });
                }
                if (item.status !== payload.status) {
                    await refreshSecurityIncidents();
                }
                showToast("Raw JSON saved. The admin document now reflects your full override.");
                closeModal();
            } catch (error) {
                showToast(error.message || "Failed to save raw JSON.", "error");
            }
        };

        function renderIncidentActionOptions(incident) {
            const actions = incident?.analysis?.recommendedActions?.length
                ? incident.analysis.recommendedActions
                : (incident?.availableActions || []).map(action => ({
                    actionId: action.id,
                    title: action.title,
                    priority: 'medium',
                    rationale: action.selectionHint || action.backendEffect || '',
                    consequences: action.defaultConsequence || ''
                }));

            if (!actions.length) {
                return `<p class="text-sm text-gray-500">No recommended backend actions were generated for this incident yet.</p>`;
            }

            return actions.map(action => `
                <label class="block border border-gray-800 rounded-2xl p-4 bg-gray-950/70 hover:border-blue-500/40 transition cursor-pointer">
                    <div class="flex items-start gap-3">
                        <input type="checkbox" data-incident-action="${escapeHtml(incident.id)}" value="${escapeHtml(action.actionId)}" class="mt-1 h-4 w-4 text-blue-500 bg-gray-900 border-gray-700 rounded focus:ring-blue-500">
                        <div class="flex-1">
                            <div class="flex flex-wrap items-center gap-2 mb-2">
                                <span class="font-bold text-white">${escapeHtml(action.title)}</span>
                                <span class="px-2 py-1 rounded-full text-[10px] uppercase tracking-widest bg-gray-800 text-gray-400">${escapeHtml(action.priority || 'medium')}</span>
                            </div>
                            <p class="text-sm text-gray-300">${escapeHtml(action.rationale || '')}</p>
                            <p class="text-xs text-amber-300 mt-2">${escapeHtml(action.consequences || '')}</p>
                        </div>
                    </div>
                </label>
            `).join('');
        }

        function renderIncidentHistory(incident) {
            if (!incident?.appliedActions?.length) {
                return `<p class="text-sm text-gray-500">No backend actions have been applied yet.</p>`;
            }

            return incident.appliedActions.slice().reverse().map(entry => `
                <div class="border border-gray-800 rounded-2xl p-4 bg-gray-950/70">
                    <div class="flex flex-wrap items-center gap-2 mb-2">
                        <span class="font-bold text-white">${escapeHtml(entry.actionId)}</span>
                        <span class="px-2 py-1 rounded-full text-[10px] uppercase tracking-widest bg-gray-800 text-gray-400">${escapeHtml(entry.status || 'recorded')}</span>
                    </div>
                    <p class="text-sm text-gray-300">${escapeHtml(entry.summary || '')}</p>
                    <p class="text-xs text-gray-500 mt-2">${escapeHtml(entry.appliedAt || '')} by ${escapeHtml(entry.actor || 'admin')}</p>
                </div>
            `).join('');
        }

        window.openIncidentModal = async (incidentId) => {
            try {
                const incident = await fetchIncidentDetail(incidentId);
                if (!incident) {
                    showToast("Incident not found.", "error");
                    return;
                }

                const hardeningList = (incident.analysis?.preventativeHardening || []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
                const limitsList = (incident.analysis?.limits || []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
                const findings = (incident.findings || []).map(finding => `
                    <div class="border border-gray-800 rounded-2xl p-4 bg-gray-950/70">
                        <div class="flex flex-wrap items-center gap-2 mb-2">
                            <span class="px-2 py-1 rounded-full text-[10px] uppercase tracking-widest bg-red-500/10 text-red-400 border border-red-500/20">${escapeHtml(finding.kind || 'finding')}</span>
                            <span class="px-2 py-1 rounded-full text-[10px] uppercase tracking-widest bg-gray-800 text-gray-400">${escapeHtml(finding.severity || 'block')}</span>
                        </div>
                        <p class="text-sm text-gray-300">${escapeHtml(finding.reason || '')}</p>
                    </div>
                `).join('');

                openModal(`
                    <div class="glass-card p-8 rounded-[2.5rem] w-full max-w-4xl border border-red-500/20 shadow-2xl relative fade-in max-h-[90vh] overflow-y-auto">
                        <button onclick="closeModal()" class="absolute top-6 right-6 text-gray-500 hover:text-white transition"><i class="fa-solid fa-times text-xl"></i></button>
                        <div class="pr-10">
                            <div class="flex flex-wrap items-center gap-3 mb-4">
                                <div class="w-12 h-12 bg-red-500/10 rounded-2xl flex items-center justify-center text-red-400 border border-red-500/20">
                                    <i class="fa-solid fa-shield-virus text-xl"></i>
                                </div>
                                <div>
                                    <h3 class="text-2xl font-bold text-white">Security Incident</h3>
                                    <p class="text-xs uppercase tracking-[0.2em] text-gray-500">${escapeHtml(incident.file?.originalName || incident.id)}</p>
                                </div>
                                ${getIncidentStatusBadge(incident.status)}
                            </div>

                            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                <div class="space-y-4">
                                    <div class="border border-gray-800 rounded-2xl p-5 bg-gray-950/70">
                                        <div class="text-xs uppercase tracking-widest text-gray-500 mb-2">AI / Analyst Summary</div>
                                        <p class="text-white font-bold mb-2">${escapeHtml(getIncidentHeadline(incident))}</p>
                                        <p class="text-sm text-gray-300 mb-3">${escapeHtml(incident.analysis?.incidentStory || '')}</p>
                                        <div class="grid grid-cols-2 gap-3 text-xs text-gray-500">
                                            <div>Provider: <span class="text-gray-300">${escapeHtml(incident.analysis?.provider || 'fallback')}</span></div>
                                            <div>Confidence: <span class="text-gray-300">${escapeHtml(incident.analysis?.confidence || 'medium')}</span></div>
                                        </div>
                                    </div>

                                    <div class="border border-gray-800 rounded-2xl p-5 bg-gray-950/70">
                                        <div class="text-xs uppercase tracking-widest text-gray-500 mb-2">Technical Assessment</div>
                                        <p class="text-sm text-gray-300">${escapeHtml(incident.analysis?.technicalAssessment || '')}</p>
                                    </div>

                                    <div class="border border-gray-800 rounded-2xl p-5 bg-gray-950/70">
                                        <div class="text-xs uppercase tracking-widest text-gray-500 mb-2">User-Facing Response</div>
                                        <p class="text-sm text-gray-300">${escapeHtml(incident.analysis?.userFacingMessage || '')}</p>
                                    </div>

                                    <div class="border border-gray-800 rounded-2xl p-5 bg-gray-950/70">
                                        <div class="text-xs uppercase tracking-widest text-gray-500 mb-3">Raw Findings</div>
                                        <div class="space-y-3">${findings || `<p class="text-sm text-gray-500">No findings were recorded.</p>`}</div>
                                    </div>
                                </div>

                                <div class="space-y-4">
                                    <div class="border border-gray-800 rounded-2xl p-5 bg-gray-950/70">
                                        <div class="text-xs uppercase tracking-widest text-gray-500 mb-2">Operator Guidance</div>
                                        <p class="text-sm text-gray-300">${escapeHtml(incident.analysis?.operatorGuidance || '')}</p>
                                    </div>

                                    <div class="border border-gray-800 rounded-2xl p-5 bg-gray-950/70">
                                        <div class="flex items-center justify-between mb-3">
                                            <div class="text-xs uppercase tracking-widest text-gray-500">Selectable Backend Actions</div>
                                            <button onclick="reanalyzeIncident('${escapeHtml(incident.id)}')" class="text-xs font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300 transition">Re-run AI</button>
                                        </div>
                                        <div class="space-y-3">${renderIncidentActionOptions(incident)}</div>
                                        <button onclick="applySelectedIncidentActions('${escapeHtml(incident.id)}')" class="w-full mt-4 btn-gradient text-white font-bold py-3 rounded-2xl transition shadow-lg">Apply Selected Actions</button>
                                    </div>

                                    <div class="border border-gray-800 rounded-2xl p-5 bg-gray-950/70">
                                        <div class="text-xs uppercase tracking-widest text-gray-500 mb-3">Preventative Hardening</div>
                                        ${hardeningList ? `<ul class="list-disc list-inside space-y-2 text-sm text-gray-300">${hardeningList}</ul>` : `<p class="text-sm text-gray-500">No hardening guidance generated.</p>`}
                                    </div>

                                    <div class="border border-gray-800 rounded-2xl p-5 bg-gray-950/70">
                                        <div class="text-xs uppercase tracking-widest text-gray-500 mb-3">Limits / Caveats</div>
                                        ${limitsList ? `<ul class="list-disc list-inside space-y-2 text-sm text-gray-300">${limitsList}</ul>` : `<p class="text-sm text-gray-500">No limitations were recorded.</p>`}
                                    </div>

                                    <div class="border border-gray-800 rounded-2xl p-5 bg-gray-950/70">
                                        <div class="text-xs uppercase tracking-widest text-gray-500 mb-3">Applied Actions</div>
                                        <div class="space-y-3">${renderIncidentHistory(incident)}</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                `);
            } catch (error) {
                console.error(error);
                showToast(error.message || "Failed to open incident.", "error");
            }
        };

        window.applySelectedIncidentActions = async (incidentId) => {
            const selected = [...document.querySelectorAll(`input[data-incident-action="${incidentId}"]:checked`)].map(input => input.value);
            if (!selected.length) {
                showToast("Select at least one incident action first.", "error");
                return;
            }

            try {
                await callSecurityBackend(`/api/incidents/${incidentId}/actions`, 'POST', {
                    actor: 'admin-panel',
                    actionIds: selected
                });
                await refreshSecurityIncidents();
                showToast("Incident actions applied on the backend.");
                closeModal();
            } catch (error) {
                console.error(error);
                showToast(error.message || "Failed to apply incident actions.", "error");
            }
        };

        window.reanalyzeIncident = async (incidentId) => {
            try {
                await callSecurityBackend(`/api/incidents/${incidentId}/reanalyze`, 'POST', {
                    actor: 'admin-panel'
                });
                await refreshSecurityIncidents();
                showToast("Incident analysis refreshed.");
                await window.openIncidentModal(incidentId);
            } catch (error) {
                console.error(error);
                showToast(error.message || "Failed to re-run incident analysis.", "error");
            }
        };

        // --- Render Functions ---
        function renderDashboard() {
            const container = document.getElementById('main-content');
            const incidentCards = securityIncidents.slice(0, 8).map(incident => `
                <div class="glass-card rounded-[2rem] border border-red-500/10 p-5 shadow-xl">
                    <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
                        <div>
                            <div class="text-[10px] uppercase tracking-[0.2em] text-gray-500 mb-1">Blocked Upload Incident</div>
                            <h3 class="font-bold text-white text-sm break-all">${escapeHtml(incident.file?.originalName || incident.id)}</h3>
                        </div>
                        ${getIncidentStatusBadge(incident.status)}
                    </div>
                    <p class="text-sm text-gray-300 leading-relaxed mb-4">${escapeHtml(getIncidentHeadline(incident))}</p>
                    <div class="grid grid-cols-1 gap-2 text-xs text-gray-500 mb-4">
                        <div>Uploader: <span class="text-gray-300">${escapeHtml(incident.submission?.uploaderEmail || incident.submission?.uploaderId || 'Unknown')}</span></div>
                        <div>Analyst: <span class="text-gray-300">${escapeHtml(incident.analysis?.provider || 'fallback')}</span></div>
                        <div>Updated: <span class="text-gray-300">${escapeHtml(new Date(incident.lastUpdatedAt || incident.createdAt).toLocaleString())}</span></div>
                    </div>
                    <button onclick="openIncidentModal('${escapeHtml(incident.id)}')" class="w-full bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 font-bold py-3 rounded-2xl transition">Open Incident</button>
                </div>
            `).join('');
            
            const rows = adminItems
            .slice()
            .sort((a, b) => {
                const left = getSortableTimestampValue(a.updatedAt) || getSortableTimestampValue(a.createdAt);
                const right = getSortableTimestampValue(b.updatedAt) || getSortableTimestampValue(b.createdAt);
                return right - left;
            })
            .map(i => {
                const isPending = i.status === 'pending';
                const isApproved = i.status === 'approved';
                const catInfo = getCategoryInfo(i.category);
                const primaryVideo = getPrimaryEmbeddableVideo(i);
                const storageBadge = isSensitiveItem(i)
                    ? `<p class="text-[10px] text-red-400 mt-1 uppercase tracking-wider"><i class="fa-solid fa-user-shield mr-1"></i>server-only sensitive item</p>`
                    : `<p class="text-[10px] text-blue-400 mt-1 uppercase tracking-wider"><i class="fa-solid fa-globe mr-1"></i>public catalog item</p>`;
                const statusBadge = isPending 
                    ? `<span class="px-3 py-1 text-xs rounded-full font-bold uppercase bg-yellow-500/10 text-yellow-500 border border-yellow-500/20"><i class="fa-solid fa-clock mr-1"></i> Pending</span>`
                    : isApproved
                    ? `<span class="px-3 py-1 text-xs rounded-full font-bold uppercase bg-green-500/10 text-green-500 border border-green-500/20"><i class="fa-solid fa-check mr-1"></i> Approved</span>`
                    : `<span class="px-3 py-1 text-xs rounded-full font-bold uppercase bg-red-500/10 text-red-500 border border-red-500/20"><i class="fa-solid fa-ban mr-1"></i> Rejected</span>`;

                return `
                <tr class="hover:bg-gray-800/30 transition border-b border-gray-800/50 group">
                    <td class="p-5">
                        <div class="flex items-center gap-4">
                            <div class="w-10 h-10 bg-blue-600/10 rounded-xl flex items-center justify-center ${catInfo.color} border border-blue-500/20">
                                <i class="fa-solid ${catInfo.icon}"></i>
                            </div>
                            <div>
                                <h3 class="font-bold text-white text-sm truncate max-w-[250px]" title="${i.title.replace(/"/g, '&quot;')}">${i.title}</h3>
                                <p class="text-[10px] text-gray-500 uppercase tracking-wider">${catInfo.label}</p>
                                ${storageBadge}
                                <p class="text-[10px] text-blue-400 mt-1 break-all">${escapeHtml(getItemShareSlug(i))}</p>
                                ${collectBackendScanIds(i).length > 0 ? `<p class="text-[10px] text-amber-400 mt-1 uppercase tracking-wider"><i class="fa-solid fa-file-shield mr-1"></i>${collectBackendScanIds(i).length} backend-scanned asset(s)</p>` : ''}
                            </div>
                        </div>
                    </td>
                    <td class="p-5 text-sm text-gray-400">
                        <div class="flex items-center gap-2">
                            <i class="fa-solid fa-user-astronaut text-gray-600"></i> ${i.submitterEmail || 'Admin'}
                        </div>
                    </td>
                    <td class="p-5">${statusBadge}</td>
                    <td class="p-5 flex justify-end gap-2">
                        <button onclick="copyItemShareLinkById('${i.id}')" class="w-8 h-8 rounded-lg bg-slate-500/10 text-slate-300 flex items-center justify-center hover:bg-slate-600 hover:text-white transition" title="Copy Public Item Link"><i class="fa-solid fa-link text-xs"></i></button>
                        <button onclick="openPublicItem('${i.id}')" class="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-300 flex items-center justify-center hover:bg-indigo-600 hover:text-white transition" title="Open Public Item Page"><i class="fa-solid fa-up-right-from-square text-xs"></i></button>
                        ${primaryVideo ? `<button onclick="previewVideoItem('${i.id}', '${primaryVideo.shareSlug}')" class="w-8 h-8 rounded-lg bg-red-500/10 text-red-400 flex items-center justify-center hover:bg-red-600 hover:text-white transition" title="Preview Video"><i class="fa-brands fa-youtube text-xs"></i></button>` : ''}
                        <button onclick="editItem('${i.id}')" class="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center hover:bg-blue-600 hover:text-white transition" title="Edit Metadata & URLs"><i class="fa-solid fa-pen text-xs"></i></button>
                        ${!isApproved ? `<button onclick="updateStatus('${i.id}', 'approved')" class="w-8 h-8 rounded-lg bg-green-500/10 text-green-500 flex items-center justify-center hover:bg-green-600 hover:text-white transition" title="Approve"><i class="fa-solid fa-check text-xs"></i></button>` : ''}
                        ${i.status !== 'rejected' ? `<button onclick="updateStatus('${i.id}', 'rejected')" class="w-8 h-8 rounded-lg bg-orange-500/10 text-orange-400 flex items-center justify-center hover:bg-orange-600 hover:text-white transition" title="Reject"><i class="fa-solid fa-xmark text-xs"></i></button>` : ''}
                        <button onclick="removeItem('${i.id}')" class="w-8 h-8 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center hover:bg-red-600 hover:text-white transition" title="Delete Permenantly"><i class="fa-solid fa-trash text-xs"></i></button>
                    </td>
                </tr>`;
            }).join('');

            container.innerHTML = `
                <div class="fade-in">
                    <div class="flex justify-between items-end mb-8">
                        <div>
                            <h2 class="text-3xl font-extrabold text-white">Active Nodes & Submissions</h2>
                            <p class="text-gray-500 mt-1">Manage streams globally across the cluster.</p>
                        </div>
                        <div class="flex items-center gap-2 bg-gray-900 px-4 py-2 rounded-full border border-gray-800 shadow-inner">
                            <span class="status-dot status-online"></span>
                            <span class="text-xs font-bold uppercase tracking-wider text-gray-400">Database Connected</span>
                        </div>
                    </div>

                    <div class="mb-8">
                        <div class="flex flex-wrap items-end justify-between gap-4 mb-4">
                            <div>
                                <h3 class="text-xl font-bold text-white">Backend Security Incidents</h3>
                                <p class="text-gray-500 text-sm mt-1">Blocked uploads stay server-side and are reviewed here with analyst guidance.</p>
                            </div>
                            <button onclick="refreshSecurityIncidents()" class="px-4 py-2 rounded-xl border border-gray-800 bg-gray-900 hover:bg-gray-800 text-sm font-bold text-white transition">Refresh Incidents</button>
                        </div>

                        ${securityIncidents.length === 0 ? `
                            <div class="glass-card rounded-[2rem] border border-gray-800 p-8 text-center">
                                <i class="fa-solid fa-shield-check text-3xl text-green-500 mb-3"></i>
                                <p class="text-white font-bold">No blocked incidents are waiting right now.</p>
                                <p class="text-sm text-gray-500 mt-2">When the backend blocks an upload, it will appear here with findings and guided actions.</p>
                            </div>
                        ` : `
                            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                                ${incidentCards}
                            </div>
                        `}
                    </div>

                    ${adminItems.length === 0 ? `
                        <div class="py-20 text-center border-2 border-dashed border-gray-800 rounded-[2rem] glass-card">
                            <i class="fa-solid fa-inbox text-5xl text-gray-700 mb-4"></i>
                            <p class="text-gray-500 font-medium">No assets deployed yet. Start by creating a new deployment.</p>
                        </div>
                    ` : `
                        <div class="glass-card rounded-[2rem] overflow-hidden border border-gray-800 shadow-2xl">
                            <div class="overflow-x-auto">
                                <table class="w-full text-left border-collapse min-w-[700px]">
                                    <thead>
                                        <tr class="bg-gray-900/80 border-b border-gray-800 text-gray-500 text-xs uppercase tracking-widest">
                                            <th class="p-5 font-bold">Asset Overview</th>
                                            <th class="p-5 font-bold">Submitter</th>
                                            <th class="p-5 font-bold">Status</th>
                                            <th class="p-5 font-bold text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-gray-800/50">
                                        ${rows}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    `}
                </div>
            `;
        }

        window.toggleAdminUploadSource = (source) => {
            const uploadRow = document.getElementById('up-source-upload');
            const urlRow = document.getElementById('up-source-url');
            const fileInput = document.getElementById('up-file');
            const urlInput = document.getElementById('up-url');

            if (!uploadRow || !urlRow || !fileInput || !urlInput) return;

            const useUpload = source !== 'url';
            uploadRow.classList.toggle('hidden', !useUpload);
            urlRow.classList.toggle('hidden', useUpload);
            fileInput.required = useUpload;
            urlInput.required = !useUpload;
        };

        function renderUpload() {
            document.getElementById('main-content').innerHTML = `
                <div class="max-w-3xl mx-auto py-4 fade-in">
                    <form onsubmit="handleInfiniteUpload(event)" class="glass-card p-10 rounded-[2.5rem] space-y-6 shadow-2xl border border-blue-500/20">
                        <div class="flex items-center gap-4 mb-2">
                            <div class="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/30">
                                <i class="fa-solid fa-cloud-arrow-up text-white text-xl"></i>
                            </div>
                            <div>
                                <h2 class="text-2xl font-bold text-white">Direct Admin Deployment</h2>
                                <p class="text-gray-500 text-xs">Deploy public content normally, or store sensitive content in the backend-only catalog with gated access.</p>
                            </div>
                        </div>
                        
                        <div class="space-y-4">
                            <div class="group">
                                <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Asset Name</label>
                                <input id="up-title" required class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition" placeholder="e.g. Restoration Documentary Collection">
                            </div>

                            <div class="group">
                                <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Description</label>
                                <textarea id="up-desc" required class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 h-32 text-white focus:border-blue-500 outline-none transition" placeholder="Explain what this file or stream is for..."></textarea>
                            </div>
                            
                            <div class="group">
                                <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Cover Image URL (Optional)</label>
                                <input type="url" id="up-img" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 text-white focus:border-blue-500 outline-none transition" placeholder="Paste an image URL for the cover art...">
                            </div>

                            <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
                                <div class="group">
                                    <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Category</label>
                                    <select id="up-cat" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 text-white outline-none focus:border-blue-500">
                                        ${Object.entries(CATEGORY_INFO).map(([key, info]) => `
                                            <option value="${key}" ${key === 'video' ? 'selected' : ''}>${info.label}</option>
                                        `).join('')}
                                    </select>
                                </div>
                                <div class="group">
                                    <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Source Mode</label>
                                    <div class="bg-gray-950 border border-gray-800 rounded-2xl p-5 flex flex-wrap gap-6 text-sm text-gray-300">
                                        <label class="flex items-center gap-2 cursor-pointer"><input type="radio" name="up-source" value="upload" checked onchange="toggleAdminUploadSource(this.value)" class="h-4 w-4 text-blue-500"> Backend Scanned File</label>
                                        <label class="flex items-center gap-2 cursor-pointer"><input type="radio" name="up-source" value="url" onchange="toggleAdminUploadSource(this.value)" class="h-4 w-4 text-blue-500"> Direct URL / YouTube</label>
                                    </div>
                                </div>
                                <div class="group">
                                    <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Storage Mode</label>
                                    <div class="bg-gray-950 border border-gray-800 rounded-2xl p-5 space-y-3 text-sm text-gray-300">
                                        <label class="flex items-start gap-3 cursor-pointer">
                                            <input type="radio" name="up-visibility" value="public" checked class="h-4 w-4 mt-1 text-blue-500">
                                            <span><span class="font-bold text-white block">Public Catalog</span><span class="text-xs text-gray-500">Visible through the normal public app and Firestore catalog.</span></span>
                                        </label>
                                        <label class="flex items-start gap-3 cursor-pointer">
                                            <input type="radio" name="up-visibility" value="sensitive" class="h-4 w-4 mt-1 text-red-500">
                                            <span><span class="font-bold text-red-400 block">Sensitive / Server Only</span><span class="text-xs text-gray-500">Metadata stays on your backend and the file routes require backend access.</span></span>
                                        </label>
                                    </div>
                                </div>
                            </div>

                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div class="group">
                                    <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Public Item Slug (Optional)</label>
                                    <input id="up-item-slug" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 text-white focus:border-blue-500 outline-none transition" placeholder="custom-item-url">
                                </div>
                                <div class="group">
                                    <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Public File Slug (Optional)</label>
                                    <input id="up-file-slug" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 text-white focus:border-blue-500 outline-none transition" placeholder="custom-file-url">
                                </div>
                            </div>

                            <div class="group">
                                <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">File Label</label>
                                <input id="up-file-label" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 text-white focus:border-blue-500 outline-none transition" placeholder="e.g. Trailer, Full Stream, Download Package">
                            </div>

                            <div id="up-source-upload" class="group">
                                <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Physical File</label>
                                <input type="file" id="up-file" required class="relative w-full bg-gray-950 border border-gray-800 rounded-2xl p-[18px] text-xs text-gray-500 file:bg-blue-600 file:border-0 file:rounded-xl file:px-4 file:py-2 file:text-white file:font-bold file:mr-4 hover:border-gray-700 transition cursor-pointer">
                            </div>

                            <div id="up-source-url" class="group hidden">
                                <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Direct URL / YouTube Link</label>
                                <input type="url" id="up-url" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 text-white focus:border-blue-500 outline-none transition" placeholder="https://www.youtube.com/watch?v=...">
                                <p class="text-xs text-gray-500 mt-2">Use this for trusted embeds like YouTube or for admin-approved external sources you want the Hub to publish.</p>
                            </div>
                        </div>
                        <button type="submit" class="w-full btn-gradient py-5 rounded-2xl font-bold text-white text-lg shadow-xl mt-4"><i class="fa-solid fa-satellite-dish mr-2"></i> Deploy to Nexus Hub</button>
                    </form>
                </div>
            `;

            window.toggleAdminUploadSource('upload');
        }

        window.handleInfiniteUpload = async (e) => {
            e.preventDefault();
            const sourceType = document.querySelector('input[name="up-source"]:checked')?.value || 'upload';
            const visibility = document.querySelector('input[name="up-visibility"]:checked')?.value || 'public';
            const file = document.getElementById('up-file').files[0];
            const directUrl = document.getElementById('up-url').value.trim();
            const title = document.getElementById('up-title').value.trim();
            const desc = document.getElementById('up-desc').value.trim();
            const cat = normalizeCategory(document.getElementById('up-cat').value);
            const img = document.getElementById('up-img').value.trim();
            const customItemSlug = document.getElementById('up-item-slug').value.trim();
            const customFileSlug = document.getElementById('up-file-slug').value.trim();
            const fileLabel = document.getElementById('up-file-label').value.trim();

            if (sourceType === 'upload' && !file) {
                showToast("Choose a file to deploy.", "error");
                return;
            }

            if (sourceType === 'url' && !directUrl) {
                showToast("Paste the direct URL or YouTube link first.", "error");
                return;
            }

            if (visibility === 'sensitive' && sourceType === 'url' && !getEmbeddableVideoMeta(directUrl)) {
                showToast("Sensitive direct links should be backend uploads or YouTube embeds.", "error");
                return;
            }

            const itemShareSlug = customItemSlug
                ? sanitizeShareSlug(customItemSlug, 'item')
                : createShareSlug(title || 'item', 'item');
            const resolvedFileLabel = fileLabel || file?.name || title || 'Published File';
            const fileShareSlug = customFileSlug
                ? sanitizeShareSlug(customFileSlug, 'file')
                : createShareSlug(resolvedFileLabel, 'file');

            const overlay = document.getElementById('processing-overlay');
            const bar = document.getElementById('proc-bar');
            const perc = document.getElementById('proc-perc');
            const stat = document.getElementById('proc-status');
            
            overlay.classList.remove('hidden');

            const updateStatus = (p, text) => {
                bar.style.width = p + '%';
                perc.innerText = Math.round(p) + '%';
                stat.innerText = text;
            };

            try {
                if (sourceType === 'url') {
                    updateStatus(20, visibility === 'sensitive' ? "Saving sensitive metadata to backend..." : "Publishing admin-controlled direct URL...");

                    const itemPayload = {
                        title,
                        description: desc,
                        category: cat,
                        shareSlug: itemShareSlug,
                        imageUrl: img,
                        status: 'approved',
                        visibility,
                        submitterEmail: 'Admin',
                        files: [{
                            name: resolvedFileLabel,
                            url: directUrl,
                            type: cat,
                            shareSlug: fileShareSlug,
                            uploadedAt: new Date().toISOString()
                        }]
                    };

                    if (visibility === 'sensitive') {
                        await createSensitiveBackendItem(itemPayload);
                        await refreshSensitiveItems();
                    } else {
                        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'content_hub_items'), {
                            ...itemPayload,
                            createdAt: serverTimestamp()
                        });
                    }

                    updateStatus(100, visibility === 'sensitive' ? "Sensitive item stored on backend." : "Direct link published.");
                    showToast(visibility === 'sensitive'
                        ? "Sensitive item stored in backend-only catalog."
                        : "Admin link deployed with its own public routes.");
                    setTimeout(() => {
                        overlay.classList.add('hidden');
                        setTab('dashboard');
                    }, 900);
                    return;
                }

                updateStatus(5, "Sending file to backend quarantine...");
                const scanPayload = await uploadToSecurityBackend(file, {
                    displayTitle: title,
                    category: cat,
                    visibility,
                    uploaderId: 'admin',
                    uploaderEmail: 'Admin',
                    fileRole: 'admin_deployment',
                    fileLabel: file.name,
                    fileCategory: cat
                }, updateStatus);

                updateStatus(88, "Releasing clean admin upload from quarantine...");
                const releasePayload = await callSecurityBackend(`/api/uploads/${scanPayload.id}/release`, 'POST', { actor: 'admin-upload' });
                const releasedReport = releasePayload.report;

                updateStatus(95, "Syncing metadata with Database...");

                // Add document to completely free tier of Firestore Text Database
                const itemPayload = {
                    title,
                    description: desc,
                    category: cat,
                    shareSlug: itemShareSlug,
                    imageUrl: img,
                    status: 'approved',
                    visibility,
                    submitterEmail: 'Admin',
                    files: [{
                        name: resolvedFileLabel,
                        url: resolveSecurityBackendDownloadUrl(releasePayload),
                        type: cat,
                        shareSlug: fileShareSlug,
                        size: (file.size / (1024 * 1024)).toFixed(2) + ' MB',
                        uploadedAt: new Date().toISOString(),
                        backendScan: buildBackendScanMetaFromReport(releasedReport)
                    }]
                };

                if (visibility === 'sensitive') {
                    await createSensitiveBackendItem(itemPayload);
                    await refreshSensitiveItems();
                } else {
                    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'content_hub_items'), {
                        ...itemPayload,
                        createdAt: serverTimestamp()
                    });
                }

                updateStatus(100, "Deployment Successful!");
                showToast(visibility === 'sensitive'
                    ? "Sensitive file stored in backend-only catalog and protected routes."
                    : "Stream scanned, released, and synced to the Hub!");
                await refreshSecurityIncidents();
                
                setTimeout(() => {
                    overlay.classList.add('hidden');
                    setTab('dashboard');
                }, 1000);

            } catch (err) {
                console.error(err);
                await refreshSecurityIncidents();
                showToast("Upload Failed: " + err.message, "error");
                overlay.classList.add('hidden');
            }
        };



        window.abortOperation = () => location.reload();
        bootstrapAdminConsole();
