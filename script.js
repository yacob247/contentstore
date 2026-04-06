        import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
        import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
        import { getFirestore, collection, onSnapshot, addDoc, serverTimestamp, deleteDoc, doc, updateDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";


        let db, auth, currentTab = 'dashboard';
        let adminItems = []; // Store fetched items
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'infinite-nexus-v1';
        const SECURITY_BACKEND_BASE_URL = (typeof __security_backend_url !== 'undefined' ? __security_backend_url : 'http://127.0.0.1:8787').replace(/\/+$/, '');

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

        // --- Initialization ---
        window.unlockAdmin = async (e) => {
            e.preventDefault();
            if (document.getElementById('admin-key').value === 'password123') {
                document.getElementById('auth-overlay').classList.add('hidden');
                document.getElementById('workspace').classList.remove('hidden');
                document.getElementById('workspace').classList.add('flex');
                
                document.getElementById('main-content').innerHTML = `
                    <div class="flex justify-center items-center h-64 flex-col fade-in">
                        <i class="fa-solid fa-circle-notch fa-spin text-4xl text-blue-500 mb-4"></i>
                        <p class="text-gray-400 font-medium">Connecting to Database Cluster...</p>
                    </div>`;

                try { await init(); } 
                catch(err) {
                    console.error("Initialization error", err);
                    document.getElementById('main-content').innerHTML = `
                        <div class="flex justify-center items-center h-64 flex-col text-center fade-in">
                            <i class="fa-solid fa-triangle-exclamation text-4xl text-red-500 mb-4"></i>
                            <p class="text-white font-bold text-xl">Database Connection Failed</p>
                            <p class="text-gray-400 text-sm mt-2 max-w-md">${err.message}</p>
                            <button onclick="location.reload()" class="mt-6 px-6 py-2 bg-gray-800 rounded-xl hover:bg-gray-700 transition">Retry Connection</button>
                        </div>`;
                }
            } else { 
                showToast("Key Denied. Incorrect administration password.", "error"); 
            }
        };

        async function init() {
            const app = initializeApp(firebaseConfig);
            auth = getAuth(app);
            db = getFirestore(app);

            await signInAnonymously(auth);
            
            // Setup listener for all documents
            const q = collection(db, 'artifacts', appId, 'public', 'data', 'content_hub_items');
            onSnapshot(q, snap => {
                adminItems = snap.docs.map(d => ({id: d.id, ...d.data()}));
                if(currentTab === 'dashboard') renderDashboard();
            }, err => {
                console.error(err);
                showToast("Failed to sync realtime data.", "error");
            });

            setTab('dashboard');
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

        function getSecurityBackendReportUrl(scanId) {
            return buildSecurityBackendUrl(`/api/uploads/report/${scanId}`);
        }

        function getSecurityBackendFileUrl(scanId) {
            return buildSecurityBackendUrl(`/api/uploads/${scanId}/file`);
        }

        function getItemById(id) {
            return adminItems.find(i => i.id === id) || null;
        }

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
            const response = await fetch(buildSecurityBackendUrl(path), {
                method,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: body ? JSON.stringify(body) : undefined
            });

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

        function buildBackendScanMetaFromReport(report) {
            if (!report?.id) return null;
            return {
                id: report.id,
                status: report.status,
                verdict: report.verdict,
                reportUrl: getSecurityBackendReportUrl(report.id),
                fileUrl: getSecurityBackendFileUrl(report.id),
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
                xhr.send(formData);
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
                    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', id), { status });
                    showToast(releasedCount > 0 ? `Stream approved and ${releasedCount} quarantined asset(s) released.` : "Stream marked as approved.", 'success');
                    return;
                }

                if (status === 'rejected') {
                    const rejectedCount = await rejectItemSecurityAssets(item);
                    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', id), { status });
                    showToast(rejectedCount > 0 ? `Stream rejected and ${rejectedCount} quarantined asset(s) were rejected in the backend.` : "Stream marked as rejected.", 'warning');
                    return;
                }

                await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', id), { status });
                showToast(`Stream marked as ${status}.`, status === 'approved' ? 'success' : 'warning');
            } catch (e) { showToast("Error updating status.", "error"); }
        };

        window.removeItem = async (id) => {
            if(confirm("Permanently purge this asset from the Hub? It will be deleted for everyone.")) {
                try {
                    await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', id));
                    showToast("Asset purged successfully.");
                } catch(e) { showToast("Failed to delete.", "error"); }
            }
        };

        window.editItem = (id) => {
            const item = adminItems.find(i => i.id === id);
            if (!item) return;
            openModal(`
                <div class="glass-card p-8 rounded-[2.5rem] w-full max-w-lg border border-blue-500/20 shadow-2xl relative fade-in">
                    <button onclick="closeModal()" class="absolute top-6 right-6 text-gray-500 hover:text-white transition"><i class="fa-solid fa-times text-xl"></i></button>
                    <div class="flex items-center gap-4 mb-6">
                        <div class="w-12 h-12 bg-blue-600/10 rounded-2xl flex items-center justify-center text-blue-500 border border-blue-500/20">
                            <i class="fa-solid fa-pen-to-square text-xl"></i>
                        </div>
                        <h3 class="text-2xl font-bold text-white">Edit Stream</h3>
                    </div>
                    
                    <div class="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
                        <div class="group">
                            <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Title</label>
                            <input type="text" id="edit-title" value="${item.title.replace(/"/g, '&quot;')}" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-white focus:border-blue-500 outline-none transition">
                        </div>
                        
                        <div class="group">
                            <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Description</label>
                            <textarea id="edit-desc" rows="3" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-white focus:border-blue-500 outline-none transition">${item.description}</textarea>
                        </div>
                        
                        <div class="group">
                            <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Category</label>
                            <select id="edit-cat" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-white focus:border-blue-500 outline-none transition">
                                <option value="software" ${item.category==='software'?'selected':''}>Software / Apps</option>
                                <option value="media" ${item.category==='media'?'selected':''}>Movies / Videos</option>
                                <option value="docs" ${item.category==='docs'?'selected':''}>Guides / PDFs</option>
                                <option value="collection" ${item.category==='collection'?'selected':''}>Collections (Mixed)</option>
                                <option value="document" ${item.category==='document'?'selected':''}>Texts & Documents</option>
                                <option value="audio" ${item.category==='audio'?'selected':''}>Audio / Music</option>
                                <option value="image" ${item.category==='image'?'selected':''}>Images / Photos</option>
                                <option value="archive" ${item.category==='archive'?'selected':''}>Archives</option>
                                <option value="other" ${item.category==='other'?'selected':''}>Misc / Other</option>
                            </select>
                        </div>

                        <div class="group">
                            <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Cover Image URL</label>
                            ${item.imageScan?.id
                                ? `<div class="bg-gray-950 border border-gray-800 rounded-2xl p-4 text-sm text-gray-300">
                                    <div class="flex items-center gap-2 text-amber-400 font-bold mb-2"><i class="fa-solid fa-file-shield"></i> Backend-managed cover image</div>
                                    <p class="text-xs text-gray-500 mb-3">This cover image is served by the security backend after release. To change it, edit the item from the user workspace and upload a new image.</p>
                                    <input type="text" value="${(item.imageScan.reportUrl || '').replace(/"/g, '&quot;')}" readonly class="w-full bg-black/30 border border-gray-800 rounded-xl p-3 text-xs text-gray-400 outline-none">
                                  </div>`
                                : `<input type="url" id="edit-img" value="${(item.imageUrl || '').replace(/"/g, '&quot;')}" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-4 text-white focus:border-blue-500 outline-none transition" placeholder="https://...">`
                            }
                        </div>
                        
                        <div class="group bg-gray-900/50 p-4 rounded-2xl border border-gray-800">
                            <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-3 ml-1"><i class="fa-solid fa-link text-blue-500 mr-1"></i> Stream / File URLs</label>
                            <div class="space-y-3">
                                ${(item.files || []).map((f, idx) => `
                                    <div class="relative">
                                        <span class="absolute left-3 top-3 text-[10px] font-bold text-gray-600 uppercase">File ${idx + 1}</span>
                                        ${f.backendScan?.id
                                            ? `<div class="w-full bg-gray-950 border border-gray-800 rounded-xl px-3 pt-7 pb-3 text-sm text-gray-300">
                                                <div class="text-amber-400 text-xs font-bold mb-1"><i class="fa-solid fa-file-shield mr-1"></i>Backend-managed file</div>
                                                <div class="text-xs text-gray-500 break-all">${(f.backendScan.reportUrl || '').replace(/</g, '&lt;')}</div>
                                              </div>`
                                            : `<input type="text" id="edit-file-url-${idx}" value="${(f.url || '').replace(/"/g, '&quot;')}" class="w-full bg-gray-950 border border-gray-800 rounded-xl px-3 pt-7 pb-2 text-sm text-gray-300 focus:border-blue-500 outline-none transition" placeholder="Stream URL">`
                                        }
                                    </div>
                                `).join('')}
                                ${(!item.files || item.files.length === 0) ? `<p class="text-xs text-gray-600 italic">No stream links attached to this node.</p>` : ''}
                            </div>
                        </div>
                    </div>
                    
                    <div class="flex gap-3 pt-6 mt-2 border-t border-gray-800">
                        <button onclick="closeModal()" class="flex-1 bg-gray-900 hover:bg-gray-800 border border-gray-800 text-white font-bold py-4 rounded-2xl transition">Cancel</button>
                        <button onclick="saveEdit('${id}')" class="flex-1 btn-gradient text-white font-bold py-4 rounded-2xl transition shadow-lg">Save Changes</button>
                    </div>
                </div>
            `);
        };

        window.saveEdit = async (id) => {
            const title = document.getElementById('edit-title').value;
            const description = document.getElementById('edit-desc').value;
            const category = document.getElementById('edit-cat').value;
            const item = adminItems.find(i => i.id === id);
            if (!item) return;
            const imageUrlInput = document.getElementById('edit-img');
            const imageUrl = imageUrlInput ? imageUrlInput.value : (item.imageUrl || '');
            
            // Map over original items array to update URLs
            let updatedFiles = item.files ? [...item.files] : [];
            updatedFiles.forEach((f, idx) => {
                const urlInput = document.getElementById(`edit-file-url-${idx}`);
                if (urlInput) {
                    f.url = urlInput.value.trim();
                }
            });

            try {
                await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', id), { 
                    title, description, category, imageUrl, files: updatedFiles 
                });
                showToast("Stream metadata and links updated.");
                closeModal();
            } catch (e) { showToast("Failed to update data.", "error"); }
        };

        // --- Render Functions ---
        function renderDashboard() {
            const container = document.getElementById('main-content');
            
            const rows = adminItems.sort((a,b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0)).map(i => {
                const isPending = i.status === 'pending';
                const isApproved = i.status === 'approved';
                const statusBadge = isPending 
                    ? `<span class="px-3 py-1 text-xs rounded-full font-bold uppercase bg-yellow-500/10 text-yellow-500 border border-yellow-500/20"><i class="fa-solid fa-clock mr-1"></i> Pending</span>`
                    : isApproved
                    ? `<span class="px-3 py-1 text-xs rounded-full font-bold uppercase bg-green-500/10 text-green-500 border border-green-500/20"><i class="fa-solid fa-check mr-1"></i> Approved</span>`
                    : `<span class="px-3 py-1 text-xs rounded-full font-bold uppercase bg-red-500/10 text-red-500 border border-red-500/20"><i class="fa-solid fa-ban mr-1"></i> Rejected</span>`;

                return `
                <tr class="hover:bg-gray-800/30 transition border-b border-gray-800/50 group">
                    <td class="p-5">
                        <div class="flex items-center gap-4">
                            <div class="w-10 h-10 bg-blue-600/10 rounded-xl flex items-center justify-center text-blue-500 border border-blue-500/20">
                                <i class="fa-solid ${i.category === 'software' ? 'fa-box-archive' : i.category === 'media' || i.category === 'video' ? 'fa-clapperboard' : 'fa-file-lines'}"></i>
                            </div>
                            <div>
                                <h3 class="font-bold text-white text-sm truncate max-w-[250px]" title="${i.title.replace(/"/g, '&quot;')}">${i.title}</h3>
                                <p class="text-[10px] text-gray-500 uppercase tracking-wider">${i.category}</p>
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

        function renderUpload() {
            document.getElementById('main-content').innerHTML = `
                <div class="max-w-2xl mx-auto py-4 fade-in">
                    <form onsubmit="handleInfiniteUpload(event)" class="glass-card p-10 rounded-[2.5rem] space-y-6 shadow-2xl border border-blue-500/20">
                        <div class="flex items-center gap-4 mb-2">
                            <div class="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/30">
                                <i class="fa-solid fa-cloud-arrow-up text-white text-xl"></i>
                            </div>
                            <div>
                                <h2 class="text-2xl font-bold text-white">Direct Admin Deployment</h2>
                                <p class="text-gray-500 text-xs">Files are scanned by the backend, released from quarantine, then published</p>
                            </div>
                        </div>
                        
                        <div class="space-y-4">
                            <div class="group">
                                <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Asset Name</label>
                                <input id="up-title" required class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition" placeholder="e.g. Photoshop Portable 2024">
                            </div>

                            <div class="group">
                                <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Description</label>
                                <textarea id="up-desc" required class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 h-32 text-white focus:border-blue-500 outline-none transition" placeholder="Explain what this file is for..."></textarea>
                            </div>
                            
                            <div class="group">
                                <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Cover Image URL (Optional)</label>
                                <input type="url" id="up-img" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 text-white focus:border-blue-500 outline-none transition" placeholder="Paste an image URL for the cover art...">
                            </div>

                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div class="group">
                                    <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Category</label>
                                    <select id="up-cat" class="w-full bg-gray-950 border border-gray-800 rounded-2xl p-5 text-white outline-none focus:border-blue-500">
                                        <option value="software">Software / Apps</option>
                                        <option value="media">Movies / Videos</option>
                                        <option value="docs">Guides / PDFs</option>
                                        <option value="collection">Mixed / Collection</option>
                                        <option value="archive">Archives</option>
                                    </select>
                                </div>
                                <div class="group">
                                    <label class="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Physical File</label>
                                    <div class="relative group">
                                        <input type="file" id="up-file" multiple webkitdirectory required class="relative w-full bg-gray-950 border border-gray-800 rounded-2xl p-[18px] text-xs text-gray-500 file:bg-blue-600 file:border-0 file:rounded-xl file:px-4 file:py-2 file:text-white file:font-bold file:mr-4 hover:border-gray-700 transition cursor-pointer">
                                    </div>
                                </div>
                            </div>
                        </div>
                        <button type="submit" class="w-full btn-gradient py-5 rounded-2xl font-bold text-white text-lg shadow-xl mt-4"><i class="fa-solid fa-satellite-dish mr-2"></i> Deploy to Nexus Hub</button>
                    </form>
                </div>
            `;
        }

        window.handleInfiniteUpload = async (e) => {
            e.preventDefault();
            const file = document.getElementById('up-file').files[0];
            const title = document.getElementById('up-title').value;
            const desc = document.getElementById('up-desc').value;
            const cat = document.getElementById('up-cat').value;
            const img = document.getElementById('up-img').value;

            if(!file) return;

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
                updateStatus(5, "Sending file to backend quarantine...");
                const scanPayload = await uploadToSecurityBackend(file, {
                    displayTitle: title,
                    category: cat,
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
                await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'content_hub_items'), {
                    title, 
                    description: desc, 
                    category: cat, 
                    imageUrl: img,
                    status: 'approved',
                    submitterEmail: 'Admin',
                    createdAt: serverTimestamp(),
                    files: [{
                        name: file.name,
                        url: getSecurityBackendFileUrl(scanPayload.id),
                        type: cat,
                        size: (file.size / (1024 * 1024)).toFixed(2) + ' MB',
                        uploadedAt: new Date().toISOString(),
                        backendScan: buildBackendScanMetaFromReport(releasedReport)
                    }]
                });

                updateStatus(100, "Deployment Successful!");
                showToast("Stream scanned, released, and synced to the Hub!");
                
                setTimeout(() => {
                    overlay.classList.add('hidden');
                    setTab('dashboard');
                }, 1000);

            } catch (err) {
                console.error(err);
                showToast("Upload Failed: " + err.message, "error");
                overlay.classList.add('hidden');
            }
        };



        window.abortOperation = () => location.reload();
