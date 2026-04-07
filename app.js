   import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
        import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
        import { getFirestore, collection, onSnapshot, addDoc, serverTimestamp, deleteDoc, doc, updateDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
        import { auditSubmissionDraft } from "./security/sandbox-auditor.js";
        import { uploadFileToGofile } from "./gofile-storage.js";
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



        const state = {
            currentView: 'home',
            currentCategory: 'all',
            publicCatalogItems: [],
            allItems: [], 
            items: [],    
            folders: [],  
            currentFolderId: null, 
            draftFolderId: null,   
            user: null,
            isLoading: true,
            // Edit & Upload State Extensions
            editingItemId: null,
            originalItem: null, // Stores item before edits to detect changes
            draftMeta: { title: '', description: '', category: 'collection' },
            draftImage: { inputType: 'url', url: '', file: null },
            draftFiles: [],
            auditErrors: [],
            lastHandledShareRoute: ''
        };

        const CATEGORIES = {
            'collection': { label: 'Collections (Mixed)', icon: 'fa-layer-group', color: 'text-purple-500' },
            'document': { label: 'Texts & Documents', icon: 'fa-book', color: 'text-orange-400' },
            'video': { label: 'Movies & Video', icon: 'fa-film', color: 'text-red-500' },
            'audio': { label: 'Audio & Music', icon: 'fa-music', color: 'text-pink-400' },
            'image': { label: 'Images & Photos', icon: 'fa-image', color: 'text-green-400' },
            'software': { label: 'Software & Apps', icon: 'fa-laptop-code', color: 'text-cyan-400' },
            'archive': { label: 'Archives', icon: 'fa-file-zipper', color: 'text-yellow-500' },
            'other': { label: 'Misc / Other', icon: 'fa-file', color: 'text-gray-400' }
        };

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
        const SECURITY_BACKEND_HEALTH_TIMEOUT_MS = 4000;
        const SECURITY_BACKEND_UPLOAD_TIMEOUT_MS = 120000;

        let app, auth, db, appId;
        let unsubPublic = null;
        let unsubPrivate = null;

        function getCategoryInfo(category) {
            return CATEGORIES[normalizeCategory(category)] || CATEGORIES['other'];
        }

        function normalizeCatalogItemRecord(rawItem, origin = 'firestore') {
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

        function syncCatalogCollections() {
            state.allItems = [...state.publicCatalogItems];
            state.items = state.publicCatalogItems.filter(i => i.status === 'approved');
        }

        function getPublicAppBaseUrl() {
            return `${window.location.origin}${window.location.pathname}${window.location.search}`;
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

        function parseShareRoute(hash = window.location.hash) {
            const match = String(hash || '').match(/^#\/(item|watch)\/([^/]+)(?:\/([^/]+))?$/);
            if (!match) return null;

            return {
                type: match[1],
                itemSlug: decodeURIComponent(match[2] || ''),
                fileSlug: decodeURIComponent(match[3] || '')
            };
        }

        function userCanAccessItem(item) {
            return item?.status === 'approved' || (state.user && !state.user.isAnonymous && item?.submitterUid === state.user.uid);
        }

        function findItemByShareSlug(slug) {
            return state.allItems.find(item => userCanAccessItem(item) && getItemShareSlug(item) === slug) || null;
        }

        function findFileByShareSlug(item, fileSlug) {
            const files = Array.isArray(item?.files) ? item.files : [];

            for (let index = 0; index < files.length; index++) {
                const file = files[index];
                if (getFileShareSlug(item, file, index) === fileSlug) {
                    return { file, index };
                }
            }

            return null;
        }

        function clearShareHash() {
            if (!parseShareRoute()) return;
            history.pushState({}, '', getPublicAppBaseUrl());
            state.lastHandledShareRoute = '';
        }

        async function handleShareRoute() {
            const route = parseShareRoute();
            const routeKey = route ? `${route.type}:${route.itemSlug}:${route.fileSlug || ''}` : '';

            if (!route) {
                state.lastHandledShareRoute = '';
                const modal = document.getElementById('modal-container');
                if (modal && !modal.classList.contains('hidden') && modal.dataset.shareRoute === 'true') {
                    window.closeModal(false);
                }
                return;
            }

            if (state.isLoading) return;
            if (routeKey === state.lastHandledShareRoute) return;

            let item = findItemByShareSlug(route.itemSlug);
            if (!item) {
                return;
            }

            state.lastHandledShareRoute = routeKey;

            if (route.type === 'watch' && route.fileSlug) {
                const match = findFileByShareSlug(item, route.fileSlug);
                if (match && getEmbeddableVideoMeta(match.file)) {
                    window.openVideoFromItem(item.id, route.fileSlug, { syncHash: false });
                    return;
                }
            }

            window.openItemModal(item.id, { syncHash: false });
        }

        async function init() {
            renderLoading();
            try {
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
                app = initializeApp(firebaseConfig);
                auth = getAuth(app);
                db = getFirestore(app);
                appId = typeof __app_id !== 'undefined' ? __app_id : 'infinite-nexus-v1';

                window.state = state; 

                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    await signInWithCustomToken(auth, __initial_auth_token);
                } else {
                    await signInAnonymously(auth);
                }

                window.addEventListener('hashchange', handleShareRoute);

                onAuthStateChanged(auth, (user) => {
                    state.user = user;
                    updateAuthUI();
                    setupDataListener();
                });
            } catch (error) {
                showToast("Failed to connect to secure backend.", "error");
            }
        }

        function setupDataListener() {
            if (!unsubPublic) {
                const itemsRef = collection(db, 'artifacts', appId, 'public', 'data', 'content_hub_items');
                unsubPublic = onSnapshot(itemsRef, (snapshot) => {
                    state.publicCatalogItems = snapshot.docs.map(doc => normalizeCatalogItemRecord({ id: doc.id, ...doc.data() }, 'firestore'));
                    syncCatalogCollections();
                    state.isLoading = false;
                    render();
                    handleShareRoute();
                }, (error) => console.error("Data fetch error:", error));
            }

            if (state.user && !state.user.isAnonymous) {
                if (!unsubPrivate) {
                    const foldersRef = collection(db, 'artifacts', appId, 'users', state.user.uid, 'folders');
                    unsubPrivate = onSnapshot(foldersRef, (snapshot) => {
                        state.folders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a,b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
                        if (['my_folders', 'folder_view', 'submit'].includes(state.currentView)) render();
                    }, (error) => console.error("Folder fetch error:", error));
                }
            } else {
                if (unsubPrivate) { unsubPrivate(); unsubPrivate = null; }
                state.folders = [];
            }
        }

        // Navigation & Editing router logic
        window.navigate = (view, itemId = null) => {
            if (parseShareRoute()) clearShareHash();
            if ((view === 'submit' || view === 'my_folders' || view === 'folder_view') && (!state.user || state.user.isAnonymous)) {
                showAuthModal('login');
                return;
            }
            state.currentView = view;
            
            if (view === 'submit') {
                state.auditErrors = [];
                if (itemId) {
                    const item = state.allItems.find(i => i.id === itemId);
                    if (item) {
                        state.editingItemId = itemId;
                        state.originalItem = item; // Keep track of the original
                        state.draftFolderId = item.folderId || '';
                        state.draftMeta = { title: item.title, description: item.description, category: normalizeCategory(item.category) };
                        state.draftImage = { inputType: 'url', url: item.imageUrl || '', file: null };
                        state.draftFiles = (item.files || []).map((f, i) => ({ 
                            ...f, 
                            id: Date.now() + i, 
                            type: normalizeCategory(f.type || item.category),
                            inputType: 'url' // Treat existing file links as URLs internally to preserve them
                        }));
                    }
                } else {
                    state.editingItemId = null;
                    state.originalItem = null;
                    state.draftMeta = { title: '', description: '', category: 'collection' };
                    state.draftImage = { inputType: 'url', url: '', file: null };
                    state.draftFiles = [];
                }
            }
            
            document.querySelectorAll('.nav-btn').forEach(btn => {
                const isMatch = btn.dataset.view === state.currentView || (state.currentView === 'folder_view' && btn.dataset.view === 'my_folders');
                if(isMatch) {
                    btn.classList.add('bg-gray-700', 'text-white');
                    btn.classList.remove('text-gray-300');
                } else {
                    btn.classList.remove('bg-gray-700', 'text-white');
                    btn.classList.add('text-gray-300');
                }
            });
            render();
        };

        window.setCategory = (cat) => { state.currentCategory = cat; render(); };

        function updateAuthUI() {
            const authSection = document.getElementById('auth-nav-section');
            const navWorkspace = document.getElementById('nav-workspace');
            if (state.user && !state.user.isAnonymous) {
                if(navWorkspace) navWorkspace.classList.remove('hidden');
                authSection.innerHTML = `
                    <div class="flex flex-col text-right hidden sm:block">
                        <span class="text-xs text-green-400"><i class="fa-solid fa-shield-check"></i> Verified Account</span>
                        <span class="text-sm font-bold text-white truncate max-w-[120px]" title="${state.user.email}">${state.user.email}</span>
                    </div>
                    <button onclick="handleLogout()" class="text-gray-400 hover:text-red-400 transition-colors ml-2" title="Sign Out"><i class="fa-solid fa-power-off text-lg"></i></button>
                `;
            } else {
                if(navWorkspace) navWorkspace.classList.add('hidden');
                authSection.innerHTML = `
                    <button onclick="showAuthModal('login')" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-lg text-sm font-bold transition-colors shadow-lg flex items-center gap-2"><i class="fa-solid fa-lock text-xs"></i> Sign In</button>
                `;
            }
        }

        window.showToast = (message, type = 'success') => {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            const color = type === 'success' ? 'bg-gray-800 border border-green-500' : 'bg-gray-800 border border-red-500';
            const icon = type === 'success' ? '<i class="fa-solid fa-circle-check text-green-500"></i>' : '<i class="fa-solid fa-triangle-exclamation text-red-500"></i>';
            toast.className = `${color} text-white px-4 py-3 rounded-lg shadow-xl flex items-center gap-3 transform transition-all duration-300 translate-y-10 opacity-0 min-w-[250px]`;
            toast.innerHTML = `<div class="text-xl">${icon}</div><span class="font-medium text-sm">${message}</span>`;
            container.appendChild(toast);
            setTimeout(() => toast.classList.remove('translate-y-10', 'opacity-0'), 10);
            setTimeout(() => { toast.classList.add('translate-y-10', 'opacity-0'); setTimeout(() => toast.remove(), 300); }, 3000);
        };

        window.openModal = (htmlContent, options = {}) => {
            const modal = document.getElementById('modal-container');
            modal.innerHTML = htmlContent;
            modal.dataset.shareRoute = options.shareRoute ? 'true' : '';
            modal.classList.remove('hidden');
            setTimeout(() => modal.classList.remove('opacity-0'), 10);
        };

        window.closeModal = (clearShareRouteOnClose = true) => {
            if (clearShareRouteOnClose && parseShareRoute()) {
                clearShareHash();
            }
            const modal = document.getElementById('modal-container');
            modal.classList.add('opacity-0');
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.innerHTML = '';
                delete modal.dataset.shareRoute;
            }, 300);
        };

        window.showLegalModal = (type) => {
            const titles = { privacy: "Privacy Policy", terms: "Terms of Service", refund: "Refund & Return Policy" };
            const content = `
                <div class="bg-gray-900 rounded-xl w-full max-w-2xl border border-gray-700 shadow-2xl relative p-8 fade-in text-left max-h-[80vh] overflow-y-auto">
                    <button onclick="closeModal()" class="absolute top-4 right-4 text-gray-400 hover:text-white"><i class="fa-solid fa-times text-xl"></i></button>
                    <div class="flex items-center gap-3 mb-6 border-b border-gray-800 pb-4">
                        <i class="fa-solid fa-file-contract text-blue-500 text-2xl"></i>
                        <h2 class="text-2xl font-bold text-white">${titles[type]}</h2>
                    </div>
                    <div class="text-gray-300 space-y-4 text-sm leading-relaxed">
                        <p><strong>Last Updated: April 6, 2026</strong></p>
                        <p>Welcome to Envizion Work's Content Store. Your privacy, security, and trust are our highest priorities.</p>
                        <h3 class="text-lg font-bold text-white mt-6 mb-2">1. Data Security & Encryption</h3>
                        <p>We utilize AES-256 bit encryption for all data transmissions. We do not sell, rent, or distribute your personal information to third-party data brokers under any circumstances.</p>
                        <h3 class="text-lg font-bold text-white mt-6 mb-2">2. Community Moderation</h3>
                        <p>All content uploaded to our platform is subject to automated malware scanning and community guidelines review. We maintain a zero-tolerance policy for malicious software or illegal content.</p>
                        <p class="italic text-gray-500 mt-8">* This is a demonstration legal document for Envizion Work platform trust purposes.</p>
                    </div>
                    <div class="mt-8 pt-4 border-t border-gray-800 text-right">
                        <button onclick="closeModal()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg transition-colors">I Understand</button>
                    </div>
                </div>
            `;
            openModal(content);
        }

        // Auth Handlers
        window.showAuthModal = (mode = 'login') => {
            openModal(`
                <div class="bg-gray-900 rounded-2xl w-full max-w-md border border-gray-700 shadow-2xl relative p-8 fade-in">
                    <button onclick="closeModal()" class="absolute top-4 right-4 text-gray-400 hover:text-white"><i class="fa-solid fa-times text-xl"></i></button>
                    <div class="text-center mb-6">
                        <div class="w-16 h-16 bg-blue-600/20 text-blue-500 rounded-full flex items-center justify-center mx-auto mb-4 border border-blue-500/50">
                            <i class="fa-solid fa-shield-check text-3xl"></i>
                        </div>
                        <h2 class="text-2xl font-bold text-white mb-1">${mode === 'login' ? 'Secure Login' : 'Create Secure Account'}</h2>
                        <p class="text-gray-400 text-sm">Join our verified community to manage your workspace.</p>
                    </div>
                    <button onclick="handleGoogleAuth()" class="w-full bg-white text-gray-900 font-bold py-3 px-4 rounded-xl mb-4 flex items-center justify-center gap-3 hover:bg-gray-100 transition shadow">
                        <img src="https://www.svgrepo.com/show/475656/google-color.svg" class="w-5 h-5"> Continue with Google
                    </button>
                    <div class="flex items-center my-4 text-gray-600"><div class="flex-grow border-t border-gray-700"></div><span class="px-3 text-xs font-medium uppercase tracking-wider">Or email</span><div class="flex-grow border-t border-gray-700"></div></div>
                    <form onsubmit="handleEmailAuth(event, '${mode}')" class="space-y-4">
                        <div>
                            <div class="relative">
                                <i class="fa-solid fa-envelope absolute left-4 top-3.5 text-gray-500"></i>
                                <input type="email" id="auth-email" required class="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-4 py-3 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all" placeholder="Email Address">
                            </div>
                        </div>
                        <div>
                            <div class="relative">
                                <i class="fa-solid fa-lock absolute left-4 top-3.5 text-gray-500"></i>
                                <input type="password" id="auth-password" required class="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-4 py-3 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all" placeholder="Password">
                            </div>
                        </div>
                        <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition mt-2 shadow-lg flex justify-center items-center gap-2"><i class="fa-solid fa-right-to-bracket"></i> ${mode === 'login' ? 'Sign In' : 'Create Account'}</button>
                    </form>
                    <p class="text-center text-gray-400 mt-4 text-sm">
                        ${mode === 'login' ? "Don't have an account?" : "Already have an account?"} 
                        <button onclick="showAuthModal('${mode === 'login' ? 'signup' : 'login'}')" class="text-blue-500 font-bold hover:underline">${mode === 'login' ? 'Sign Up' : 'Sign In'}</button>
                    </p>
                </div>
            `);
        };

        window.handleGoogleAuth = async () => {
            try { await signInWithPopup(auth, new GoogleAuthProvider()); closeModal(); showToast("Successfully authenticated."); } 
            catch (e) { showToast(e.message, "error"); }
        };

        window.handleEmailAuth = async (e, mode) => {
            e.preventDefault();
            const em = document.getElementById('auth-email').value, pw = document.getElementById('auth-password').value;
            try {
                if (mode === 'signup') await createUserWithEmailAndPassword(auth, em, pw);
                else await signInWithEmailAndPassword(auth, em, pw);
                closeModal(); showToast("Secure login successful!");
            } catch (e) { showToast(e.message, "error"); }
        };

        window.handleLogout = async () => {
            try { await signOut(auth); await signInAnonymously(auth); showToast("Signed out securely."); if (state.currentView !== 'home') navigate('home'); } 
            catch (e) { showToast("Error signing out.", "error"); }
        };

        // Modals
        window.copyItemShareLink = async (itemId) => {
            const item = state.allItems.find(entry => entry.id === itemId);
            if (!item) return;
            await copyTextToClipboard(buildItemShareUrl(item), "Item link copied.");
        };

        window.copyFileShareLink = async (itemId, fileShareSlug) => {
            const item = state.allItems.find(entry => entry.id === itemId);
            if (!item) return;

            const match = findFileByShareSlug(item, fileShareSlug);
            if (!match) return;

            const videoMeta = getEmbeddableVideoMeta(match.file);
            const linkToCopy = videoMeta
                ? buildFileShareUrl(item, match.file, match.index)
                : (match.file?.url || buildFileShareUrl(item, match.file, match.index));

            await copyTextToClipboard(linkToCopy, videoMeta ? "Video link copied." : "Download link copied.");
        };

        window.playVideo = (ytId) => {
            const video = getEmbeddableVideoMeta(`https://www.youtube.com/watch?v=${ytId}`);
            if (!video) return;
            openModal(`
                <div class="bg-gray-900 rounded-xl w-full max-w-5xl border border-gray-700 shadow-2xl relative overflow-hidden flex flex-col fade-in">
                    <div class="p-4 flex justify-between items-center border-b border-gray-800 bg-black/50">
                        <h3 class="text-white font-bold flex items-center"><i class="fa-brands fa-youtube text-red-500 mr-2 text-xl"></i> Secure Video Player</h3>
                        <button onclick="closeModal()" class="text-gray-400 hover:text-white transition-colors p-1"><i class="fa-solid fa-times text-2xl"></i></button>
                    </div>
                    <div class="relative w-full bg-black" style="padding-top: 56.25%;">
                        <iframe class="absolute inset-0 w-full h-full" src="${video.embedUrl}" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" frameborder="0" allowfullscreen></iframe>
                    </div>
                </div>
            `);
        };

        window.openVideoFromItem = (itemId, fileShareSlug = '', options = {}) => {
            const item = state.allItems.find(entry => entry.id === itemId);
            if (!item || !userCanAccessItem(item)) return;

            let fileMatch = null;

            if (fileShareSlug) {
                fileMatch = findFileByShareSlug(item, fileShareSlug);
            }

            if (!fileMatch) {
                const primaryVideo = getPrimaryEmbeddableVideo(item);
                if (primaryVideo) {
                    fileMatch = { file: primaryVideo.file, index: primaryVideo.index };
                    fileShareSlug = primaryVideo.shareSlug;
                }
            }

            if (!fileMatch) {
                window.openItemModal(itemId, { syncHash: options.syncHash });
                return;
            }

            const video = getEmbeddableVideoMeta(fileMatch.file);
            if (!video) {
                window.openItemModal(itemId, { syncHash: options.syncHash });
                return;
            }

            if (options.syncHash !== false) {
                const itemSlug = getItemShareSlug(item);
                const resolvedFileShareSlug = fileShareSlug || getFileShareSlug(item, fileMatch.file, fileMatch.index);
                const nextHash = buildFileShareHash(itemSlug, resolvedFileShareSlug);
                state.lastHandledShareRoute = `watch:${itemSlug}:${resolvedFileShareSlug}`;
                if (window.location.hash !== nextHash) {
                    window.location.hash = nextHash;
                }
            }

            openModal(`
                <div class="bg-gray-900 rounded-xl w-full max-w-5xl border border-gray-700 shadow-2xl relative overflow-hidden flex flex-col fade-in">
                    <div class="p-4 flex flex-wrap justify-between items-center gap-3 border-b border-gray-800 bg-black/50">
                        <div>
                            <h3 class="text-white font-bold flex items-center"><i class="fa-brands fa-youtube text-red-500 mr-2 text-xl"></i> ${escapeHtml(fileMatch.file.name || item.title || 'Secure Video Player')}</h3>
                            <p class="text-xs text-gray-500 mt-1">${escapeHtml(item.title || 'Shared video')}</p>
                        </div>
                        <div class="flex items-center gap-2">
                            <button onclick="copyFileShareLink('${item.id}', '${fileShareSlug || getFileShareSlug(item, fileMatch.file, fileMatch.index)}')" class="bg-gray-800 hover:bg-gray-700 text-white px-3 py-2 rounded-lg text-xs font-bold transition flex items-center gap-2 border border-gray-700">
                                <i class="fa-solid fa-link"></i> Copy Link
                            </button>
                            <button onclick="closeModal()" class="text-gray-400 hover:text-white transition-colors p-1"><i class="fa-solid fa-times text-2xl"></i></button>
                        </div>
                    </div>
                    <div class="relative w-full bg-black" style="padding-top: 56.25%;">
                        <iframe class="absolute inset-0 w-full h-full" src="${video.embedUrl}" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" frameborder="0" allowfullscreen></iframe>
                    </div>
                    <div class="px-5 py-4 border-t border-gray-800 flex flex-wrap gap-3 text-xs bg-gray-950/80">
                        <a href="${video.watchUrl}" target="_blank" rel="noopener noreferrer" class="bg-red-600 hover:bg-red-500 text-white px-3 py-2 rounded-lg font-bold transition flex items-center gap-2">
                            <i class="fa-brands fa-youtube"></i> Open on YouTube
                        </a>
                        <button onclick="copyItemShareLink('${item.id}')" class="bg-gray-800 hover:bg-gray-700 text-white px-3 py-2 rounded-lg font-bold transition flex items-center gap-2 border border-gray-700">
                            <i class="fa-solid fa-folder-open"></i> Copy Item Link
                        </button>
                    </div>
                </div>
            `, { shareRoute: true });
        };

        window.openItemModal = (id, options = {}) => {
            const item = state.allItems.find(i => i.id === id); 
            if (!item || !userCanAccessItem(item)) return;

            const imgUrl = getRenderableImageUrl(item, 'https://via.placeholder.com/800x400/1f2937/4b5563?text=Cover+Art');
            const catInfo = getCategoryInfo(item.category);
            const isOwner = state.user && !state.user.isAnonymous && item.submitterUid === state.user.uid;
            const primaryVideo = getPrimaryEmbeddableVideo(item);

            let filesHTML = item.files && item.files.length > 0 
                ? item.files.map((f, index) => getFileModalRowHTML(item, f, index)).join('')
                : `<p class="text-gray-500 italic p-4 text-center bg-gray-800 rounded-xl border border-gray-700">No downloadable files attached.</p>`;

            if (options.syncHash !== false) {
                const itemSlug = getItemShareSlug(item);
                const nextHash = buildItemShareHash(itemSlug);
                state.lastHandledShareRoute = `item:${itemSlug}:`;
                if (window.location.hash !== nextHash) {
                    window.location.hash = nextHash;
                }
            }

            openModal(`
                <div class="bg-gray-900 rounded-2xl w-full max-w-4xl border border-gray-700 shadow-2xl relative overflow-hidden flex flex-col fade-in max-h-[90vh] overflow-y-auto">
                    <button onclick="closeModal()" class="absolute top-4 right-4 text-white bg-black/60 rounded-full w-10 h-10 z-10 hover:bg-red-500 transition-colors flex items-center justify-center"><i class="fa-solid fa-times"></i></button>
                    <div class="h-64 sm:h-80 overflow-hidden relative bg-black flex-shrink-0 border-b border-gray-800">
                        <img src="${imgUrl}" onerror="this.src='https://via.placeholder.com/800x400/1f2937/4b5563?text=Art'" class="w-full h-full object-cover opacity-50 blur-[2px]">
                        <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/80 to-transparent"></div>
                        <div class="absolute bottom-8 left-8 right-8 flex gap-6 items-end">
                            <div class="flex-grow">
                                <span class="px-3 py-1 bg-gray-800/80 text-gray-300 text-xs rounded-full uppercase font-bold border border-gray-600 mb-3 inline-flex items-center gap-2 backdrop-blur-sm"><i class="fa-solid ${catInfo.icon} ${catInfo.color}"></i> ${catInfo.label}</span>
                                <h2 class="text-3xl sm:text-5xl font-extrabold text-white">${item.title}</h2>
                                <p class="text-gray-400 mt-3 flex items-center gap-2 text-sm"><img src="https://ui-avatars.com/api/?name=${item.submitterEmail || 'User'}&background=2563eb&color=fff&rounded=true&size=24" class="w-6 h-6 rounded-full border border-gray-600"> Uploaded by <span class="text-gray-200 font-medium">${item.submitterEmail || 'Verified Member'}</span></p>
                                <div class="flex flex-wrap gap-3 mt-4">
                                    ${primaryVideo ? `
                                        <button onclick="openVideoFromItem('${item.id}', '${primaryVideo.shareSlug}')" class="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-bold shadow flex items-center gap-2 transition-colors">
                                            <i class="fa-brands fa-youtube"></i> Watch
                                        </button>
                                    ` : ''}
                                    <button onclick="copyItemShareLink('${item.id}')" class="bg-gray-800/90 hover:bg-gray-700 text-white px-4 py-2 rounded-lg text-sm font-bold shadow flex items-center gap-2 transition-colors border border-gray-700">
                                        <i class="fa-solid fa-link"></i> Copy Item Link
                                    </button>
                                </div>
                            </div>
                            ${isOwner ? `
                                <button onclick="closeModal(); navigate('submit', '${item.id}')" class="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-bold shadow flex items-center gap-2 transition-colors"><i class="fa-solid fa-pen"></i> Edit</button>
                            ` : ''}
                        </div>
                    </div>
                    <div class="p-8 flex flex-col lg:flex-row gap-8">
                        <div class="lg:w-1/3">
                            <div class="bg-gray-800/50 p-6 rounded-2xl border border-gray-700 h-full">
                                <h3 class="text-xl font-bold text-white mb-4 border-b border-gray-700 pb-2">Description</h3>
                                <p class="text-gray-300 text-sm whitespace-pre-wrap leading-relaxed">${item.description}</p>
                            </div>
                        </div>
                        <div class="lg:w-2/3">
                            <div class="flex justify-between items-end mb-4">
                                <h3 class="text-2xl font-bold text-white"><i class="fa-solid fa-folder-open text-blue-500 mr-2"></i> Content Files</h3>
                                <span class="text-xs font-bold text-green-500 bg-green-500/10 px-2 py-1 rounded border border-green-500/20"><i class="fa-solid fa-shield-check"></i> Verified Status: ${item.status.toUpperCase()}</span>
                            </div>
                            <div class="space-y-3">${filesHTML}</div>
                        </div>
                    </div>
                </div>
            `, { shareRoute: true });
        };

        // Workspace Features
        window.createFolder = async () => {
            const name = prompt("Enter new folder name:");
            if (!name || !name.trim()) return;
            try {
                await addDoc(collection(db, 'artifacts', appId, 'users', state.user.uid, 'folders'), {
                    name: name.trim(),
                    createdAt: serverTimestamp()
                });
                showToast("Folder created successfully.");
            } catch (e) {
                showToast("Failed to create folder.", "error");
            }
        };

        window.openFolder = (folderId) => {
            state.currentFolderId = folderId;
            navigate('folder_view');
        };

        window.deleteFolder = async (folderId, event) => {
            event.stopPropagation();
            if (!confirm("Delete this folder? Contents will be moved to unorganized files.")) return;
            try {
                await deleteDoc(doc(db, 'artifacts', appId, 'users', state.user.uid, 'folders', folderId));
                showToast("Folder deleted.");
            } catch (e) {
                showToast("Error deleting folder.", "error");
            }
        };

        window.deleteItem = async (itemId, event) => {
            event.stopPropagation();
            if (!confirm("Permanently delete this uploaded file/item?")) return;
            try {
                await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', itemId));
                showToast("Item deleted securely.");
            } catch (e) {
                showToast("Error deleting item.", "error");
            }
        };

        // Rendering View Switcher
        function renderLoading() { document.getElementById('app-content').innerHTML = `<div class="flex justify-center items-center h-64"><i class="fa-solid fa-shield-check text-4xl text-blue-500 animate-pulse mr-3"></i> <span class="text-xl text-gray-400 font-medium">Establishing secure connection...</span></div>`; }

        function render() {
            if (state.isLoading) return;
            const contentDiv = document.getElementById('app-content');
            if (state.currentView === 'home') contentDiv.innerHTML = getHomeHTML();
            else if (state.currentView === 'submit') contentDiv.innerHTML = getSubmitHTML();
            else if (state.currentView === 'my_folders') contentDiv.innerHTML = getMyFoldersHTML();
            else if (state.currentView === 'folder_view') contentDiv.innerHTML = getFolderViewHTML();
        }

        // Reusable item renderer for Workspace views
        function renderWorkspaceItem(item) {
            let imgUrl = getRenderableImageUrl(item, 'https://via.placeholder.com/400x225/1f2937/4b5563?text=Content');
            const isPending = item.status === 'pending';
            const isRejected = item.status === 'rejected';
            
            const badge = isPending 
                ? `<span class="px-2 py-1 bg-yellow-500 text-white text-[10px] rounded shadow-lg absolute top-3 left-3 font-bold flex items-center gap-1 z-20"><i class="fa-solid fa-clock"></i> Pending</span>`
                : isRejected
                ? `<span class="px-2 py-1 bg-red-500 text-white text-[10px] rounded shadow-lg absolute top-3 left-3 font-bold flex items-center gap-1 z-20"><i class="fa-solid fa-ban"></i> Rejected</span>`
                : `<span class="px-2 py-1 bg-green-500 text-white text-[10px] rounded shadow-lg absolute top-3 left-3 font-bold flex items-center gap-1 z-20"><i class="fa-solid fa-shield-check"></i> Safe</span>`;

            return `
                <div class="bg-gray-800 rounded-2xl overflow-hidden shadow-lg border border-gray-700 hover:border-blue-500/50 transition-all duration-300 flex flex-col fade-in group cursor-pointer relative" onclick="openItemModal('${item.id}')">
                    <button onclick="navigate('submit', '${item.id}'); event.stopPropagation();" class="absolute top-3 right-12 z-30 bg-gray-900/80 hover:bg-blue-600 text-gray-400 hover:text-white w-8 h-8 rounded-full flex items-center justify-center transition-colors shadow-lg border border-gray-700" title="Edit Item"><i class="fa-solid fa-pen text-xs"></i></button>
                    <button onclick="deleteItem('${item.id}', event)" class="absolute top-3 right-3 z-30 bg-gray-900/80 hover:bg-red-600 text-gray-400 hover:text-white w-8 h-8 rounded-full flex items-center justify-center transition-colors shadow-lg border border-gray-700" title="Delete Item"><i class="fa-solid fa-trash text-xs"></i></button>
                    ${badge}
                    <div class="h-40 overflow-hidden relative bg-gray-900">
                        <img src="${imgUrl}" onerror="this.src='https://via.placeholder.com/400x225/1f2937/4b5563?text=No+Image'" class="w-full h-full object-cover group-hover:scale-105 transition duration-500 opacity-80">
                    </div>
                    <div class="p-4 flex flex-col flex-grow relative">
                        <h3 class="text-lg font-bold mb-1 text-white truncate group-hover:text-blue-400 transition-colors pr-6">${item.title}</h3>
                        <p class="text-gray-400 text-xs mb-3 line-clamp-2">${item.description}</p>
                        <div class="mt-auto border-t border-gray-700 pt-3 flex justify-between items-center text-xs">
                            <span class="text-gray-500 flex items-center gap-1"><i class="fa-solid fa-folder-closed"></i> ${item.files?.length || 0} Files</span>
                        </div>
                    </div>
                </div>
            `;
        }

        // Individual HTML Views
        function getHomeHTML() {
            let tabsHTML = `<div class="flex overflow-x-auto gap-2 pb-2 mb-8 border-b border-gray-800 hide-scrollbar">
                <button onclick="setCategory('all')" class="px-5 py-2.5 rounded-t-lg font-bold transition-colors ${state.currentCategory === 'all' ? 'bg-gray-800 text-white border-b-2 border-blue-500' : 'text-gray-400 hover:bg-gray-800'}">All Content</button>`;
            
            Object.entries(CATEGORIES).forEach(([key, info]) => {
                const count = state.items.filter(i => i.category === key).length;
                if (count > 0 || state.currentCategory === key) {
                    tabsHTML += `<button onclick="setCategory('${key}')" class="px-5 py-2.5 rounded-t-lg font-bold flex items-center gap-2 transition-colors whitespace-nowrap ${state.currentCategory === key ? 'bg-gray-800 text-white border-b-2 border-blue-500' : 'text-gray-400 hover:bg-gray-800'}"><i class="fa-solid ${info.icon} ${info.color}"></i> ${info.label} <span class="bg-gray-700 text-xs px-2 py-0.5 rounded-full text-gray-300">${count}</span></button>`;
                }
            });
            tabsHTML += `</div>`;

            const displayItems = state.currentCategory === 'all' ? state.items : state.items.filter(i => i.category === state.currentCategory);

            if (displayItems.length === 0) {
                return tabsHTML + `
                    <div class="text-center py-24 fade-in bg-gray-800/30 rounded-3xl border border-dashed border-gray-700">
                        <div class="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner"><i class="fa-solid fa-ghost text-4xl text-gray-500"></i></div>
                        <h2 class="text-2xl font-bold text-white mb-2">No content found</h2>
                        <p class="text-gray-400 mb-6 max-w-md mx-auto">This category is currently empty. Be the first to contribute to the community!</p>
                        <button onclick="navigate('submit')" class="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-full font-bold transition-colors shadow-lg shadow-blue-900/50 flex items-center gap-2 mx-auto"><i class="fa-solid fa-cloud-arrow-up"></i> Upload Securely</button>
                    </div>
                `;
            }

            const renderCard = (item) => {
                let imgUrl = getRenderableImageUrl(item, 'https://via.placeholder.com/400x225/1f2937/4b5563?text=Verified+Content');
                const catInfo = getCategoryInfo(item.category);
                const primaryVideo = getPrimaryEmbeddableVideo(item);
                if (primaryVideo?.thumbnailUrl) imgUrl = primaryVideo.thumbnailUrl;

                return `
                    <div class="bg-gray-800 rounded-2xl overflow-hidden shadow-lg border border-gray-700 hover:border-blue-500/50 transition-all duration-300 flex flex-col fade-in group cursor-pointer" onclick="${primaryVideo ? `openVideoFromItem('${item.id}', '${primaryVideo.shareSlug}')` : `openItemModal('${item.id}')`}">
                        <div class="h-48 overflow-hidden relative bg-gray-900">
                            <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-transparent to-transparent z-10 opacity-80"></div>
                            ${primaryVideo ? `<div class="absolute inset-0 flex items-center justify-center z-20"><div class="w-14 h-14 bg-red-600/90 backdrop-blur rounded-full flex items-center justify-center shadow-2xl group-hover:scale-110 transition duration-300 border-2 border-white/20"><i class="fa-solid fa-play text-white ml-1 text-xl"></i></div></div>` : ''}
                            <div class="absolute top-3 right-3 z-20"><span class="px-2.5 py-1 bg-black/70 text-[10px] rounded-md uppercase font-bold text-gray-200 border border-gray-600 backdrop-blur-md shadow-sm"><i class="fa-solid ${catInfo.icon} ${catInfo.color} mr-1"></i> ${catInfo.label}</span></div>
                            <img src="${imgUrl}" onerror="this.src='https://via.placeholder.com/400x225/1f2937/4b5563?text=Image+Not+Found'" class="w-full h-full object-cover group-hover:scale-105 transition duration-500">
                        </div>
                        <div class="p-5 flex flex-col flex-grow relative">
                            <div class="absolute -top-4 right-4 bg-green-500 text-white text-[10px] uppercase font-bold px-2 py-1 rounded shadow-lg border border-green-400 z-20 flex items-center gap-1"><i class="fa-solid fa-shield-check"></i> Safe</div>
                            <h3 class="text-xl font-bold mb-2 text-white truncate group-hover:text-blue-400 transition-colors pr-10">${item.title}</h3>
                            <p class="text-gray-400 text-sm mb-4 line-clamp-2 flex-grow leading-relaxed">${item.description}</p>
                            <div class="mt-auto border-t border-gray-700 pt-4 flex justify-between items-center text-sm">
                                <span class="text-gray-500 flex items-center gap-2"><i class="fa-solid fa-folder-closed text-gray-600"></i> ${item.files?.length || 0} Files</span>
                                <span class="text-blue-400 font-bold group-hover:text-blue-300 flex items-center">View Details <i class="fa-solid fa-arrow-right-long ml-2 transform group-hover:translate-x-1 transition-transform"></i></span>
                            </div>
                        </div>
                    </div>
                `;
            };

            return tabsHTML + `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">${displayItems.map(renderCard).join('')}</div>`;
        }

        function getMyFoldersHTML() {
            if (!state.user || state.user.isAnonymous) return `<div class="text-center py-20 text-white">Please log in to view your workspace.</div>`;

            const renderFolder = (folder) => {
                const itemCount = state.allItems.filter(i => i.submitterUid === state.user.uid && i.folderId === folder.id).length;
                return `
                    <div onclick="openFolder('${folder.id}')" class="bg-gray-800 rounded-2xl p-6 border border-gray-700 hover:border-blue-500 cursor-pointer transition-all flex flex-col items-center justify-center fade-in group relative">
                        <button onclick="deleteFolder('${folder.id}', event)" class="absolute top-2 right-2 text-gray-500 hover:text-red-400 p-2 rounded-full transition-colors opacity-0 group-hover:opacity-100 z-10"><i class="fa-solid fa-trash"></i></button>
                        <i class="fa-solid fa-folder text-5xl text-blue-500 group-hover:scale-110 transition-transform mb-4 drop-shadow-[0_0_8px_rgba(59,130,246,0.5)]"></i>
                        <h3 class="text-white font-bold text-lg text-center truncate w-full">${folder.name}</h3>
                        <p class="text-gray-400 text-sm mt-1">${itemCount} Uploads</p>
                    </div>
                `;
            };

            let content = `<div class="flex justify-between items-center mb-8 border-b border-gray-800 pb-4">
                <div>
                    <h2 class="text-3xl font-extrabold text-white">My Workspace</h2>
                    <p class="text-gray-400 mt-1">Organize your secure uploads into custom folders.</p>
                </div>
                <button onclick="createFolder()" class="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-bold transition shadow-lg flex items-center gap-2"><i class="fa-solid fa-folder-plus"></i> New Folder</button>
            </div>`;

            if (state.folders.length === 0) {
                content += `
                    <div class="text-center py-24 fade-in bg-gray-800/30 rounded-3xl border border-dashed border-gray-700">
                        <i class="fa-solid fa-folder-open text-6xl text-gray-600 mb-6"></i>
                        <h2 class="text-2xl font-bold text-white mb-2">Your workspace is empty</h2>
                        <p class="text-gray-400 mb-6 max-w-md mx-auto">Create your first folder to start grouping your file uploads.</p>
                        <button onclick="createFolder()" class="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-full font-bold transition-colors shadow-lg flex items-center gap-2 mx-auto"><i class="fa-solid fa-plus"></i> Create Folder</button>
                    </div>
                `;
            } else {
                content += `<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">${state.folders.map(renderFolder).join('')}</div>`;
            }

            const rootItems = state.allItems.filter(i => i.submitterUid === state.user.uid && !i.folderId);
            if (rootItems.length > 0) {
                content += `
                    <div class="mt-16 mb-6 border-b border-gray-800 pb-4 fade-in">
                        <h3 class="text-xl font-bold text-white flex items-center gap-2"><i class="fa-solid fa-file text-gray-500"></i> Unorganized Files (Root)</h3>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 fade-in">
                        ${rootItems.map(renderWorkspaceItem).join('')}
                    </div>
                `;
            }

            return content;
        }

        function getFolderViewHTML() {
            const folder = state.folders.find(f => f.id === state.currentFolderId);
            if (!folder) return `<div class="text-center py-20 text-white">Folder not found.</div>`;

            const folderItems = state.allItems.filter(i => i.submitterUid === state.user.uid && i.folderId === folder.id);

            let header = `
                <div class="mb-8 border-b border-gray-800 pb-4 fade-in">
                    <button onclick="navigate('my_folders')" class="text-gray-400 hover:text-white text-sm mb-4 flex items-center gap-2 transition"><i class="fa-solid fa-arrow-left"></i> Back to Workspace</button>
                    <div class="flex flex-col md:flex-row justify-between md:items-end gap-4">
                        <div class="flex items-center gap-4">
                            <i class="fa-solid fa-folder-open text-5xl text-blue-500 drop-shadow-[0_0_10px_rgba(59,130,246,0.3)]"></i>
                            <div>
                                <h2 class="text-3xl font-extrabold text-white">${folder.name}</h2>
                                <p class="text-gray-400 mt-1">${folderItems.length} items organized here</p>
                            </div>
                        </div>
                        <div class="flex gap-3">
                            <button onclick="state.draftFolderId = '${folder.id}'; navigate('submit');" class="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-bold transition shadow-lg flex items-center gap-2"><i class="fa-solid fa-cloud-arrow-up"></i> Upload File</button>
                        </div>
                    </div>
                </div>
            `;

            if (folderItems.length === 0) {
                return header + `
                    <div class="text-center py-24 fade-in bg-gray-800/30 rounded-3xl border border-dashed border-gray-700">
                        <i class="fa-solid fa-file-circle-plus text-5xl text-gray-600 mb-6"></i>
                        <h2 class="text-2xl font-bold text-white mb-2">Folder is empty</h2>
                        <p class="text-gray-400 mb-6">Start uploading content directly into this folder.</p>
                        <button onclick="state.draftFolderId = '${folder.id}'; navigate('submit');" class="bg-gray-700 hover:bg-gray-600 text-white px-6 py-2.5 rounded-full font-bold transition-colors shadow flex items-center gap-2 mx-auto"><i class="fa-solid fa-upload"></i> Upload Now</button>
                    </div>
                `;
            }

            return header + `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">${folderItems.map(renderWorkspaceItem).join('')}</div>`;
        }

        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function getAuditErrorsHTML() {
            if (!state.auditErrors.length) return '';
            return `
                <div class="bg-red-950/60 border border-red-500/40 rounded-xl p-4 shadow-inner">
                    <div class="flex items-center gap-2 text-red-200 font-bold mb-3">
                        <i class="fa-solid fa-shield-halved text-red-400"></i>
                        <span>Security scan blocked this submission</span>
                    </div>
                    <div class="space-y-2">
                        ${state.auditErrors.map(reason => `
                            <div class="flex items-start gap-3 text-sm text-red-100">
                                <i class="fa-solid fa-circle-exclamation text-red-400 mt-0.5"></i>
                                <span>${escapeHtml(reason)}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        function syncAuditErrorsUI() {
            const container = document.getElementById('audit-errors-container');
            if (container) container.innerHTML = getAuditErrorsHTML();
        }

        function clearAuditErrors() {
            if (!state.auditErrors.length) return;
            state.auditErrors = [];
            syncAuditErrorsUI();
        }

        function setAuditErrors(errors) {
            state.auditErrors = [...new Set((errors || []).filter(Boolean))];
            syncAuditErrorsUI();
        }

        function buildSecurityBackendUrl(path) {
            return `${SECURITY_BACKEND_BASE_URL}${path}`;
        }

        async function ensureSecurityBackendReady() {
            const controller = new AbortController();
            const timeoutId = window.setTimeout(() => controller.abort(), SECURITY_BACKEND_HEALTH_TIMEOUT_MS);

            try {
                const response = await fetch(buildSecurityBackendUrl('/api/health'), {
                    method: 'GET',
                    cache: 'no-store',
                    signal: controller.signal
                });

                if (!response.ok) {
                    throw new Error(`Security backend health check failed (${response.status}).`);
                }
            } catch (error) {
                throw new Error('Security backend is unavailable right now. File uploads cannot continue until the scan service is reachable.');
            } finally {
                window.clearTimeout(timeoutId);
            }
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

        function resolveSecurityBackendDownloadUrl(scanResult) {
            const downloadId = scanResult?.downloadId || scanResult?.links?.downloadId || scanResult?.id;
            if (scanResult?.downloadPath) {
                return buildSecurityBackendUrl(scanResult.downloadPath);
            }
            return getSecurityBackendDownloadUrl(downloadId);
        }

        function buildBackendScanMeta(scanResult) {
            if (!scanResult?.id) return null;
            const downloadId = scanResult?.downloadId || scanResult?.links?.downloadId || scanResult.id;
            return {
                id: scanResult.id,
                downloadId,
                status: scanResult.status,
                verdict: scanResult.verdict,
                reportUrl: getSecurityBackendReportUrl(scanResult.id),
                fileUrl: getSecurityBackendFileUrl(scanResult.id),
                downloadUrl: resolveSecurityBackendDownloadUrl(scanResult),
                findings: (scanResult.findings || []).map(finding => ({
                    kind: finding.kind || '',
                    severity: finding.severity || '',
                    reason: finding.reason || ''
                }))
            };
        }

        function getRenderableImageUrl(item, fallbackUrl) {
            if (item.imageScan && item.status !== 'approved') return fallbackUrl;
            return item.imageUrl || fallbackUrl;
        }

        function getFileModalRowHTML(item, file, index) {
            const reportUrl = file?.backendScan?.reportUrl;
            const isQuarantined = Boolean(file?.backendScan) && item.status !== 'approved';
            const hasDownload = Boolean(file?.url) && !isQuarantined;
            const videoMeta = getEmbeddableVideoMeta(file);
            const fileShareSlug = getFileShareSlug(item, file, index);
            const fileType = getCategoryInfo(file?.type || item.category);

            let actionHTML = `<span class="bg-gray-700 text-gray-300 px-4 py-2 rounded-lg font-bold text-sm">Unavailable</span>`;
            if (isQuarantined && reportUrl) {
                actionHTML = `<a href="${reportUrl}" target="_blank" class="bg-amber-600 hover:bg-amber-500 text-white px-5 py-2 rounded-lg font-bold shadow flex items-center gap-2 text-sm"><i class="fa-solid fa-file-shield"></i> <span class="hidden sm:inline">Scan Report</span></a>`;
            } else if (videoMeta) {
                actionHTML = `<button onclick="openVideoFromItem('${item.id}', '${fileShareSlug}')" class="bg-red-600 hover:bg-red-500 text-white px-5 py-2 rounded-lg font-bold shadow flex items-center gap-2 text-sm"><i class="fa-brands fa-youtube"></i> <span class="hidden sm:inline">Watch</span></button>`;
            } else if (hasDownload) {
                actionHTML = `<a href="${file.url}" target="_blank" class="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2 rounded-lg font-bold shadow flex items-center gap-2 text-sm"><i class="fa-solid fa-cloud-arrow-down"></i> <span class="hidden sm:inline">Download</span></a>`;
            }

            const statusText = isQuarantined
                ? '<i class="fa-solid fa-clock mr-1"></i>Quarantined until admin release'
                : videoMeta
                ? '<i class="fa-brands fa-youtube mr-1"></i>Embeddable YouTube video'
                : '<i class="fa-solid fa-shield-check mr-1"></i>Secure Link';

            const statusClass = isQuarantined ? 'text-amber-400' : videoMeta ? 'text-red-400' : 'text-green-400';

            return `
                <div class="flex items-center justify-between bg-gray-800 border border-gray-700 p-4 rounded-xl mb-3 hover:border-blue-500/50 transition duration-300 gap-4">
                    <div class="flex items-center gap-4 min-w-0">
                        <div class="w-10 h-10 rounded-lg bg-gray-700 flex items-center justify-center ${fileType.color || 'text-white'} bg-opacity-20 flex-shrink-0"><i class="fa-solid ${fileType.icon || 'fa-file'} text-lg"></i></div>
                        <div class="min-w-0">
                            <h4 class="text-white font-bold truncate max-w-[180px] sm:max-w-[300px] text-sm">${escapeHtml(file.name || 'File')}</h4>
                            <p class="text-xs ${statusClass} mt-0.5">${statusText}</p>
                        </div>
                    </div>
                    <div class="flex-shrink-0 flex items-center gap-2">
                        ${actionHTML}
                        <button onclick="copyFileShareLink('${item.id}', '${fileShareSlug}')" class="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg font-bold text-sm transition flex items-center gap-2 border border-gray-600">
                            <i class="fa-solid fa-link"></i> <span class="hidden sm:inline">Share</span>
                        </button>
                    </div>
                </div>`;
        }

        // Edit/Upload Form UI Helpers
        window.updateDraftMeta = (field, val) => { state.draftMeta[field] = val; clearAuditErrors(); };
        window.updateDraftImage = (field, val) => { state.draftImage[field] = val; clearAuditErrors(); if(field==='inputType') render(); };
        window.handleDraftImageFile = (el) => { if (el.files.length > 0) { state.draftImage.file = el.files[0]; clearAuditErrors(); } };

        window.addDraftFile = () => { state.draftFiles.push({ name: '', type: 'archive', inputType: 'upload', url: '', file: null, id: Date.now() }); clearAuditErrors(); renderDrafts(); };
        window.removeDraftFile = (id) => { state.draftFiles = state.draftFiles.filter(f => f.id !== id); clearAuditErrors(); renderDrafts(); };
        window.updateDraft = (id, f, v) => { const x = state.draftFiles.find(i=>i.id===id); if(x) x[f]=v; clearAuditErrors(); if(f==='inputType') renderDrafts(); };
        window.handleFile = (id, el) => { const x = state.draftFiles.find(i=>i.id===id); if(x && el.files.length>0) { x.file = el.files[0]; clearAuditErrors(); } };

        function renderDrafts() {
            const container = document.getElementById('draft-files-container');
            if(!container) return;
            if (state.draftFiles.length === 0) { container.innerHTML = `<div class="text-center p-8 border-2 border-dashed border-gray-700 rounded-xl text-gray-500 bg-gray-800/30"><i class="fa-solid fa-file-circle-plus text-3xl mb-3 text-gray-600"></i><br>No files attached yet. Click "Add File" to include content.</div>`; return; }
            container.innerHTML = state.draftFiles.map(df => `
                <div class="bg-gray-900 border border-gray-700 p-5 rounded-xl relative group hover:border-gray-500 transition-colors shadow-sm">
                    <button type="button" onclick="removeDraftFile(${df.id})" class="absolute top-3 right-3 text-gray-500 hover:text-red-500 w-8 h-8 rounded-full hover:bg-gray-800 flex items-center justify-center transition-all"><i class="fa-solid fa-trash"></i></button>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-4 pr-10">
                        <div><label class="block text-xs font-bold text-gray-400 uppercase mb-1.5 tracking-wider">File Label</label><input type="text" value="${df.name}" onchange="updateDraft(${df.id}, 'name', this.value)" required class="w-full bg-gray-800 border border-gray-600 rounded-lg p-2.5 text-white text-sm focus:border-blue-500 transition-all" placeholder="e.g. Video Part 1"></div>
                        <div><label class="block text-xs font-bold text-gray-400 uppercase mb-1.5 tracking-wider">File Type</label><select onchange="updateDraft(${df.id}, 'type', this.value)" class="w-full bg-gray-800 border border-gray-600 rounded-lg p-2.5 text-white text-sm focus:border-blue-500 transition-all">${Object.entries(CATEGORIES).map(([k,v]) => `<option value="${k}" ${df.type===k?'selected':''}>${v.label}</option>`).join('')}</select></div>
                    </div>
                    <div class="bg-gray-800/80 p-4 rounded-lg border border-gray-700">
                        <div class="flex gap-6 mb-4 text-sm font-medium border-b border-gray-700 pb-3">
                            <label class="flex items-center gap-2 cursor-pointer text-gray-300 hover:text-white transition-colors"><input type="radio" name="it_${df.id}" value="upload" ${df.inputType==='upload'?'checked':''} onchange="updateDraft(${df.id}, 'inputType', 'upload')" class="text-blue-500 focus:ring-blue-500 h-4 w-4"> <i class="fa-solid fa-upload text-gray-500"></i> Upload Device File</label>
                            <label class="flex items-center gap-2 cursor-pointer text-gray-300 hover:text-white transition-colors"><input type="radio" name="it_${df.id}" value="url" ${df.inputType==='url'?'checked':''} onchange="updateDraft(${df.id}, 'inputType', 'url')" class="text-blue-500 focus:ring-blue-500 h-4 w-4"> <i class="fa-solid fa-link text-gray-500"></i> ${state.editingItemId && df.url ? 'Keep Existing Link' : 'External URL Link'}</label>
                        </div>
                        ${df.inputType === 'url' ? `<div class="relative"><i class="fa-solid fa-globe absolute left-3 top-3 text-gray-500"></i><input type="url" value="${df.url}" onchange="updateDraft(${df.id}, 'url', this.value)" required class="w-full bg-gray-900 border border-gray-600 rounded-lg pl-9 pr-3 py-2 text-white text-sm focus:border-blue-500" placeholder="https://..."></div>` : `<input type="file" onchange="handleFile(${df.id}, this)" required class="w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-bold file:bg-blue-600 file:text-white hover:file:bg-blue-700 file:transition-colors file:cursor-pointer cursor-pointer bg-gray-900 border border-gray-600">`}
                    </div>
                </div>
            `).join('');
        }

        function getSubmitHTML() {
            if(state.draftFiles.length === 0 && !state.editingItemId) {
                state.draftFiles.push({ name: '', type: 'archive', inputType: 'upload', url: '', file: null, id: Date.now() });
            }
            setTimeout(renderDrafts, 0);
            
            // Prepare Folder Dropdown Options
            const folderOptions = `<option value="">-- Unorganized (Workspace Root) --</option>` + 
                state.folders.map(f => `<option value="${f.id}" ${state.draftFolderId === f.id ? 'selected' : ''}>📁 ${f.name}</option>`).join('');

            return `
                <div class="max-w-3xl mx-auto fade-in pb-10">
                    <form onsubmit="handleSubmission(event)" class="bg-gray-800 p-8 rounded-2xl shadow-xl border border-gray-700 space-y-8">
                        <div class="text-center mb-2">
                            <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-900/50 text-blue-400 mb-4 border border-blue-500/30 shadow-inner">
                                <i class="fa-solid ${state.editingItemId ? 'fa-pen-to-square' : 'fa-cloud-arrow-up'} text-3xl"></i>
                            </div>
                            <h1 class="text-3xl font-extrabold text-white">${state.editingItemId ? 'Edit Secure Content' : 'Secure Upload Center'}</h1>
                            <p class="text-gray-400 mt-2 text-sm max-w-lg mx-auto">${state.editingItemId ? 'Updates to text only will be saved instantly. Changing files requires moderation check.' : 'Organize your files efficiently by selecting a target folder below.'}</p>
                        </div>

                        <div class="bg-gray-900 p-6 rounded-xl border border-gray-700 space-y-5 shadow-sm">
                            <h3 class="text-lg font-bold text-white border-b border-gray-800 pb-3 flex items-center gap-2"><i class="fa-solid fa-file-lines text-gray-500"></i> Metadata & Location</h3>
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div><label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Category</label><select id="sub-cat" onchange="updateDraftMeta('category', this.value)" class="w-full bg-gray-800 border border-gray-600 rounded-lg p-3 text-white focus:border-blue-500 outline-none">${Object.entries(CATEGORIES).map(([k,v]) => `<option value="${k}" ${state.draftMeta.category===k?'selected':''}>${v.label}</option>`).join('')}</select></div>
                                <div>
                                    <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 text-blue-400"><i class="fa-solid fa-folder-open"></i> Save Location (Folder)</label>
                                    <select id="sub-folder" onchange="state.draftFolderId = this.value" class="w-full bg-gray-800 border border-blue-500/50 rounded-lg p-3 text-white focus:border-blue-500 outline-none shadow-inner bg-blue-900/10">
                                        ${folderOptions}
                                    </select>
                                </div>
                            </div>
                            <div><label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Display Title</label><input type="text" id="sub-title" value="${state.draftMeta.title}" oninput="updateDraftMeta('title', this.value)" required class="w-full bg-gray-800 border border-gray-600 rounded-lg p-3 text-white focus:border-blue-500 outline-none" placeholder="A clear, descriptive title"></div>
                            <div><label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Detailed Description</label><textarea id="sub-desc" oninput="updateDraftMeta('description', this.value)" required rows="4" class="w-full bg-gray-800 border border-gray-600 rounded-lg p-3 text-white focus:border-blue-500 outline-none" placeholder="Provide details about the content...">${state.draftMeta.description}</textarea></div>
                            
                            <!-- Updated Cover Image Input Handling -->
                            <div class="border border-gray-700 bg-gray-800 p-4 rounded-xl">
                                <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Cover Image <span class="text-gray-500 font-normal ml-1">(Optional)</span></label>
                                <div class="flex gap-4 mb-3">
                                    <label class="flex items-center gap-2 cursor-pointer text-gray-300 hover:text-white text-sm"><input type="radio" name="img_type" value="url" ${state.draftImage.inputType==='url'?'checked':''} onchange="updateDraftImage('inputType', 'url')" class="text-blue-500 focus:ring-blue-500 h-4 w-4"> Image Link URL</label>
                                    <label class="flex items-center gap-2 cursor-pointer text-gray-300 hover:text-white text-sm"><input type="radio" name="img_type" value="upload" ${state.draftImage.inputType==='upload'?'checked':''} onchange="updateDraftImage('inputType', 'upload')" class="text-blue-500 focus:ring-blue-500 h-4 w-4"> Upload from Device</label>
                                </div>
                                ${state.draftImage.inputType === 'url' ?
                                    `<input type="url" id="sub-img-url" value="${state.draftImage.url}" onchange="updateDraftImage('url', this.value)" class="w-full bg-gray-900 border border-gray-600 rounded-lg p-3 text-white focus:border-blue-500 outline-none" placeholder="https://... (Keep blank for no image)">` :
                                    `<input type="file" id="sub-img-file" accept="image/*" onchange="handleDraftImageFile(this)" class="w-full text-sm text-gray-300 file:mr-4 file:py-2.5 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-bold file:bg-blue-600 file:text-white hover:file:bg-blue-700 file:cursor-pointer cursor-pointer bg-gray-900 border border-gray-600 rounded-lg">`
                                }
                            </div>
                        </div>

                        <div class="bg-gray-800 p-6 rounded-xl border border-gray-700 relative shadow-inner">
                            <div class="flex justify-between items-center border-b border-gray-700 pb-4 mb-4">
                                <h3 class="text-lg font-bold text-white flex items-center gap-2"><i class="fa-solid fa-folder-plus text-blue-500"></i> Attached Files</h3>
                                <button type="button" onclick="addDraftFile()" class="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors shadow flex items-center gap-2"><i class="fa-solid fa-plus"></i> Add Another File</button>
                            </div>
                            <div id="draft-files-container" class="space-y-4"></div>
                        </div>

                        <div id="audit-errors-container">${getAuditErrorsHTML()}</div>

                        <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-xl text-lg shadow-xl shadow-blue-900/20 transition-all transform hover:-translate-y-0.5 flex justify-center items-center gap-3"><i class="fa-solid ${state.editingItemId ? 'fa-floppy-disk' : 'fa-paper-plane'}"></i> ${state.editingItemId ? 'Save Changes' : 'Submit to Hub & Workspace'}</button>
                    </form>
                </div>
            `;
        }

        // Upload Engine
        async function uploadToSecurityBackend(file, metadata, onProgress) {
            const formData = new FormData();
            formData.append('file', file, file.name);

            Object.entries(metadata || {}).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') formData.append(key, value);
            });

            return await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', buildSecurityBackendUrl('/api/uploads/scan'));
                xhr.timeout = SECURITY_BACKEND_UPLOAD_TIMEOUT_MS;
                xhr.upload.onprogress = onProgress;
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
                    const rejection = new Error(detailedReason);
                    rejection.status = xhr.status;
                    rejection.payload = payload;
                    reject(rejection);
                };
                xhr.onerror = () => reject(new Error("Could not reach the security backend. Start the backend service and try again."));
                xhr.ontimeout = () => reject(new Error("Security backend scan timed out before the file finished processing."));
                xhr.send(formData);
            });
        }

        async function scanFileThenUploadToGofile(file, metadata, { onBackendProgress, onGofileProgress, onStatus } = {}) {
            if (typeof onStatus === 'function') {
                onStatus('Checking security backend...');
            }

            await ensureSecurityBackendReady();

            if (typeof onStatus === 'function') {
                onStatus('Sending file to security backend...');
            }

            await uploadToSecurityBackend(file, metadata, onBackendProgress);

            if (typeof onStatus === 'function') {
                onStatus('Security scan passed. Uploading clean file to Gofile...');
            }

            const gofileUpload = await uploadFileToGofile(file, { onProgress: onGofileProgress });
            return {
                url: gofileUpload.directUrl || gofileUpload.url,
                backendScan: null,
                storageProvider: 'gofile',
                gofile: gofileUpload
            };
        }

        window.handleSubmission = async (e) => {
            e.preventDefault();
            if (!state.user || state.user.isAnonymous) return showToast("You must log in securely.", "error");
            if (state.draftFiles.length === 0) return showToast("Add at least one file to upload.", "error");

            const cat = normalizeCategory(state.draftMeta.category);
            const title = state.draftMeta.title.trim();
            const desc = state.draftMeta.description.trim();
            const folderId = state.draftFolderId || null;
            const itemShareSlug = state.originalItem
                ? getItemShareSlug(state.originalItem)
                : createShareSlug(title || 'item', 'item');
            clearAuditErrors();

            for(let f of state.draftFiles) {
                if(!f.name.trim()) return showToast("All files must have identifying labels.", "error");
                if(f.inputType === 'url' && !f.url.trim()) return showToast("Provide valid URLs for external links.", "error");
                if(f.inputType === 'upload' && !f.file) return showToast("Please select files for direct upload.", "error");
            }
            if(state.draftImage.inputType === 'upload' && !state.draftImage.file && !state.editingItemId) {
                return showToast("Please select a cover image file, or switch to URL.", "error");
            }

            e.target.querySelector('button[type="submit"]').disabled = true;
            const overlay = document.getElementById('upload-overlay'), pBar = document.getElementById('upload-progress-bar'), pText = document.getElementById('upload-percentage'), statText = document.getElementById('upload-status-text');
            overlay.classList.remove('hidden');

            try {
                statText.innerText = `Running client-side security scan...`;
                const auditResult = await auditSubmissionDraft({
                    title,
                    description: desc,
                    draftImage: state.draftImage,
                    draftFiles: state.draftFiles,
                    originalItem: state.originalItem,
                    isEditing: Boolean(state.editingItemId)
                });

                if (!auditResult.ok) {
                    setAuditErrors(auditResult.blockReasons);
                    showToast(auditResult.blockReasons[0] || "Submission blocked by the security scan.", "error");
                    return;
                }

                clearAuditErrors();

                let finalFiles = [], uploadCount = state.draftFiles.filter(f => f.inputType === 'upload').length, processedCount = 0;
                let usedScannedGofileUpload = false;
                const requiresReapproval = auditResult.requiresReapproval;
                const backendSubmissionMeta = {
                    displayTitle: title,
                    category: cat,
                    uploaderId: state.user.uid,
                    uploaderEmail: state.user.email || ''
                };

                // Handle Cover Image Upload
                let finalImgUrl = '';
                let finalImageScan = state.originalItem?.imageScan || null;
                const updatePhasedProgress = (phaseOffset, phaseSize, e, label) => {
                    if (!e.lengthComputable) return;
                    const phaseProgress = phaseOffset + ((e.loaded / e.total) * phaseSize);
                    const prog = (((processedCount * 100) + phaseProgress) / uploadCount);
                    pBar.style.width = prog + '%';
                    pText.innerText = Math.round(prog) + '%';
                    const mb = Math.round((e.loaded / 1024 / 1024) * 10) / 10;
                    statText.innerText = `${label}: ${mb} MB...`;
                };

                if (state.draftImage.inputType === 'url') {
                    finalImgUrl = state.draftImage.url;
                    if (finalImgUrl !== (state.originalItem?.imageUrl || '')) finalImageScan = null;
                } else if (state.draftImage.inputType === 'upload' && state.draftImage.file) {
                    statText.innerText = `Preparing cover image security scan...`;
                    uploadCount++; // Count cover image as an upload for progress bar
                    const imageUpload = await scanFileThenUploadToGofile(state.draftImage.file, {
                        ...backendSubmissionMeta,
                        fileRole: 'cover_image'
                    }, {
                        onBackendProgress: (e) => updatePhasedProgress(0, 45, e, 'Sending cover image to security backend'),
                        onGofileProgress: (e) => updatePhasedProgress(45, 55, e, 'Uploading clean cover image to Gofile'),
                        onStatus: (message) => { statText.innerText = message; }
                    });
                    finalImgUrl = imageUpload.url;
                    finalImageScan = imageUpload.backendScan;
                    usedScannedGofileUpload = usedScannedGofileUpload || imageUpload.storageProvider === 'gofile';
                    processedCount++;
                } else {
                    finalImgUrl = state.draftImage.url; // fallback to existing
                }

                // Handle Attached Files
                for (let draft of state.draftFiles) {
                    let fileData = {
                        name: draft.name,
                        type: normalizeCategory(draft.type || cat),
                        shareSlug: draft.shareSlug
                            ? sanitizeShareSlug(draft.shareSlug, 'file')
                            : state.originalItem
                            ? getFileShareSlug(state.originalItem, draft, finalFiles.length)
                            : createShareSlug(draft.name || draft.file?.name || `file-${finalFiles.length + 1}`, 'file')
                    };
                    if (draft.inputType === 'url') {
                        fileData.url = draft.url;
                        if (draft.backendScan) fileData.backendScan = draft.backendScan;
                    } else {
                        statText.innerText = `Preparing security scan for ${draft.file.name}...`;
                        const uploadResult = await scanFileThenUploadToGofile(draft.file, {
                            ...backendSubmissionMeta,
                            fileRole: 'attachment',
                            fileLabel: draft.name,
                            fileCategory: draft.type
                        }, {
                            onBackendProgress: (e) => updatePhasedProgress(0, 45, e, 'Sending to security backend'),
                            onGofileProgress: (e) => updatePhasedProgress(45, 55, e, 'Uploading clean file to Gofile'),
                            onStatus: (message) => { statText.innerText = message; }
                        });
                        fileData.url = uploadResult.url;
                        if (uploadResult.backendScan) {
                            fileData.backendScan = uploadResult.backendScan;
                        }
                        if (uploadResult.storageProvider === 'gofile' && uploadResult.gofile?.downloadPage) {
                            fileData.externalPageUrl = uploadResult.gofile.downloadPage;
                        }
                        usedScannedGofileUpload = usedScannedGofileUpload || uploadResult.storageProvider === 'gofile';
                        processedCount++;
                    }
                    finalFiles.push(fileData);
                }

                statText.innerText = `Verifying Data...`;
                
                // Smart Re-Approval Logic for Editing
                let finalStatus = 'pending';

                if (state.editingItemId && state.originalItem) {
                    finalStatus = requiresReapproval ? 'pending' : state.originalItem.status;
                } else {
                    finalStatus = requiresReapproval ? 'pending' : 'approved';
                }
                
                const docData = {
                    category: cat, 
                    shareSlug: itemShareSlug,
                    title, 
                    description: desc, 
                    imageUrl: finalImgUrl, 
                    imageScan: finalImageScan,
                    submitterEmail: state.user.email,
                    submitterUid: state.user.uid,
                    folderId: folderId,
                    files: finalFiles, 
                    status: finalStatus
                };

                if (state.editingItemId) {
                    docData.updatedAt = serverTimestamp();
                    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'content_hub_items', state.editingItemId), docData);
                    
                    if (requiresReapproval && state.originalItem.status === 'approved') {
                        showToast("Updates saved. Changed files passed backend scanning and the item returned to review.");
                    } else if (usedScannedGofileUpload) {
                        showToast("Updates saved. Changed files passed backend scanning and were stored on Gofile.");
                    } else {
                        showToast("Text/Metadata updated successfully!");
                    }
                } else {
                    docData.createdAt = serverTimestamp();
                    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'content_hub_items'), docData);
                    if (usedScannedGofileUpload) {
                        showToast(finalStatus === 'approved'
                            ? "Uploaded successfully! Files passed backend scanning and were stored on Gofile."
                            : "Submitted to review. Files passed backend scanning and were stored on Gofile.");
                    } else {
                        showToast(finalStatus === 'approved' ? "Uploaded successfully!" : "Submitted to quarantine review. An admin must release it before public download.");
                    }
                }
                
                // Route back gracefully
                if (folderId) {
                    state.currentFolderId = folderId;
                    navigate('folder_view');
                } else {
                    navigate('my_folders');
                }
            } catch (error) { 
                showToast("Upload failed: " + error.message, "error"); 
            } finally {
                e.target.querySelector('button[type="submit"]').disabled = false;
                overlay.classList.add('hidden');
                pBar.style.width = '0%'; pText.innerText = '0%';
            }
        };

        window.addEventListener('DOMContentLoaded', init);
