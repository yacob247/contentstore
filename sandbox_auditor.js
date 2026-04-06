const SECURITY_GATES = {
    // 1. Scan for missing Game Dependencies (Legacy & Modern)
    checkDependencies: async (file) => {
        const buffer = await file.slice(0, 50000).arrayBuffer(); // Scan first 50KB
        const content = new TextDecoder().decode(new Uint8Array(buffer));
        const errors = [];

        // Legacy Game Check (Project IGI, etc)
        if (content.includes("CD-ROM") || content.includes("MSCDEX") || content.includes("INSERT DISK")) {
            errors.push("Missing CD-ROM: This game requires a Virtual Drive or Disc Image to run correctly.");
        }

        // Graphics Check
        if (content.includes("d3d8.dll") || content.includes("d3d9.dll")) {
            errors.push("Graphics Conflict: Requires DirectX 8/9 Runtimes. Please bundle these DLLs.");
        }

        // Suspicious Hooks
        if (content.includes("cmd.exe /c") || content.includes("powershell") || content.includes("reg add")) {
            errors.push("REJECTED: Unauthorized system Registry or Shell modifications detected.");
        }

        return errors;
    },

    // 2. Virtual Execution (Web Apps)
    runVirtualTest: (file) => {
        return new Promise((resolve) => {
            if (!file.name.endsWith('.html')) return resolve([]);
            
            const reader = new FileReader();
            reader.onload = (e) => {
                const blob = new Blob([e.target.result], { type: 'text/html' });
                const url = URL.createObjectURL(blob);
                
                // Create invisible sandbox
                const frame = document.createElement('iframe');
                frame.style.display = 'none';
                frame.sandbox = "allow-scripts"; // No same-origin, no popups, no forms
                frame.src = url;
                document.body.appendChild(frame);

                // Check for "Hacking" attempts (trying to break out of frame)
                const checkTimeout = setTimeout(() => {
                    document.body.removeChild(frame);
                    resolve([]);
                }, 2000);

                window.onmessage = (msg) => {
                    if (msg.data === 'attempt_storage_access') {
                        clearTimeout(checkTimeout);
                        resolve(["Security Violation: App attempted to access protected browser storage."]);
                    }
                };
            };
            reader.readAsText(file);
        });
    }
};

/**
 * MAIN AUDIT PIPELINE
 */
export async function runSecurityStaging(file) {
    console.log("Entering Staging Environment for:", file.name);
    
    // Step 1: Run Dependency Scan
    const depErrors = await SECURITY_GATES.checkDependencies(file);
    
    // Step 2: Run Virtual Sandbox (if applicable)
    const sandboxErrors = await SECURITY_GATES.runVirtualTest(file);
    
    const allErrors = [...depErrors, ...sandboxErrors];
    
    return {
        passed: allErrors.length === 0,
        errors: allErrors,
        isMalicious: allErrors.some(e => e.includes("REJECTED"))
    };
}

/**
 * FEEDBACK LOOP: Notify user of required fixes
 */
export async function sendUserFixMessage(userId, fileName, errors) {
    const notification = {
        userId,
        fileName,
        type: 'fix_required',
        message: "Your upload failed the security staging. Details below:",
        details: errors,
        timestamp: serverTimestamp(),
        status: 'unread'
    };

    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'user_notifications'), notification);
}

// UI listener for the User Feedback Dashboard
export function listenForFixRequests(userId, callback) {
    const q = query(
        collection(db, 'artifacts', appId, 'public', 'data', 'user_notifications'),
        where("userId", "==", userId)
    );

    return onSnapshot(q, (snapshot) => {
        const notifications = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        callback(notifications);
    }, (err) => console.error("Notification sync error:", err));
}
