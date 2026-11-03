const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const AdmZip = require('adm-zip');
const { Auth } = require('msmc');
const { Client } = require('minecraft-launcher-core');
const { autoUpdater } = require('electron-updater');

const launcher = new Client();
let mainWindow;
let userAuth = null; // Session Microsoft valide
let currentAccountId = null; // Compte actuellement connecté

// Dossier de jeu propre dans AppData/Roaming
const gameDirectory = path.join(app.getPath('appData'), '.radiant-survie');

function send(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

let splashWindow;

// --- Mises à jour automatiques (via les Releases GitHub) ---
function setupAutoUpdate() {
    if (!app.isPackaged) return; // pas de MAJ en mode développement

    autoUpdater.autoDownload = true;

    autoUpdater.on('update-available', (info) => {
        send('status', `Mise à jour ${info.version} : téléchargement...`);
    });

    autoUpdater.on('download-progress', (p) => {
        send('status', {
            text: 'Téléchargement de la mise à jour...',
            percent: p.percent
        });
    });

    autoUpdater.on('update-downloaded', () => {
        send('status', 'Mise à jour prête, redémarrage...');
        setTimeout(() => autoUpdater.quitAndInstall(), 2000);
    });

    autoUpdater.on('error', (err) => {
        console.error('Erreur de mise à jour :', err);
    });

    autoUpdater.checkForUpdates().catch((err) => console.error(err));
}

function createWindow() {
    // Écran de démarrage "RADIANT"
    splashWindow = new BrowserWindow({
        width: 450,
        height: 300,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        backgroundColor: '#0b0c10',
        icon: path.join(__dirname, 'assets', 'icon.ico')
    });
    splashWindow.loadFile('splash.html');

    // Fenêtre principale, cachée tant que le splash est affiché
    mainWindow = new BrowserWindow({
        width: 900,
        height: 600,
        frame: false,
        resizable: false,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'assets', 'icon.ico')
    });
    mainWindow.loadFile('index.html');

    // On attend au moins 2,5 s ET que la fenêtre principale soit prête
    const minDelay = new Promise((resolve) => setTimeout(resolve, 2500));
    const mainReady = new Promise((resolve) => mainWindow.once('ready-to-show', resolve));

    Promise.all([minDelay, mainReady]).then(() => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        mainWindow.show();
        setupAutoUpdate();
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- Écouteurs du launcher : enregistrés UNE seule fois ---
launcher.on('debug', (e) => console.log('[MCLC]', e));

launcher.on('progress', (e) => {
    const percentage = e.total ? (e.task / e.total) * 100 : 0;
    send('status', {
        text: `Téléchargement : ${e.type}`,
        percent: percentage
    });
});

launcher.on('data', () => {
    send('status', "Jeu en cours d'exécution...");
});

launcher.on('close', () => {
    send('game-closed');
});

// --- Comptes Microsoft mémorisés (jetons chiffrés par Windows) ---
const accountsFile = path.join(app.getPath('userData'), 'accounts.json');

function loadAccounts() {
    try {
        const data = JSON.parse(fs.readFileSync(accountsFile, 'utf-8'));
        return {
            lastUsed: data.lastUsed || null,
            accounts: Array.isArray(data.accounts) ? data.accounts : []
        };
    } catch (e) {
        return { lastUsed: null, accounts: [] };
    }
}

function saveAccounts(store) {
    fs.mkdirSync(path.dirname(accountsFile), { recursive: true });
    fs.writeFileSync(accountsFile, JSON.stringify(store, null, 2));
}

function encryptToken(token) {
    if (!safeStorage.isEncryptionAvailable()) return null; // on ne stocke jamais en clair
    return safeStorage.encryptString(token).toString('base64');
}

function decryptToken(encrypted) {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
}

function sendAccounts() {
    const store = loadAccounts();
    send('accounts', {
        lastUsed: store.lastUsed,
        accounts: store.accounts.map((a) => ({ id: a.id, name: a.name }))
    });
}

function newAuth() {
    return new Auth('select_account');
}

// Termine la connexion : récupère la session Minecraft et mémorise le compte
async function finishLogin(xboxManager) {
    const token = await xboxManager.getMinecraft();
    userAuth = token.mclc();

    const id = token.profile.id;
    const name = token.profile.name;

    const encrypted = encryptToken(xboxManager.save());
    if (encrypted) {
        const store = loadAccounts();
        const existing = store.accounts.find((a) => a.id === id);
        if (existing) {
            existing.name = name;
            existing.token = encrypted;
        } else {
            store.accounts.push({ id, name, token: encrypted });
        }
        store.lastUsed = id;
        saveAccounts(store);
    }

    currentAccountId = id;
    send('login-success', { name, id });
    sendAccounts();
}

async function loginWithSaved(id) {
    const store = loadAccounts();
    const account = store.accounts.find((a) => a.id === id);
    if (!account) {
        send('status', 'Erreur : compte introuvable.');
        return;
    }
    try {
        const xboxManager = await newAuth().refresh(decryptToken(account.token));
        await finishLogin(xboxManager);
    } catch (error) {
        console.error('Erreur de reconnexion :', error);
        userAuth = null;
        currentAccountId = null;
        send('status', 'Erreur : session expirée, reconnecte ce compte avec « + Ajouter ».');
    }
}

// Au démarrage : liste des comptes + reconnexion automatique du dernier compte
ipcMain.on('get-accounts', () => {
    const store = loadAccounts();
    sendAccounts();
    if (store.lastUsed && store.accounts.some((a) => a.id === store.lastUsed)) {
        send('status', 'Connexion automatique...');
        loginWithSaved(store.lastUsed);
    }
});

// Ajouter / connecter un compte (fenêtre officielle Microsoft)
ipcMain.on('microsoft-login', async () => {
    try {
        const xboxManager = await newAuth().launch('electron');
        await finishLogin(xboxManager);
    } catch (error) {
        console.error('Erreur de connexion Microsoft :', error);
        const msg = String((error && error.message) || error);
        send('status', msg.includes('closed') ? 'Erreur : connexion annulée.' : 'Erreur : ' + msg);
    }
});

// Changer de compte
ipcMain.on('select-account', (event, id) => {
    loginWithSaved(id);
});

// Retirer un compte de la liste
ipcMain.on('remove-account', (event, id) => {
    const store = loadAccounts();
    store.accounts = store.accounts.filter((a) => a.id !== id);
    if (store.lastUsed === id) store.lastUsed = null;
    saveAccounts(store);

    if (currentAccountId === id) {
        userAuth = null;
        currentAccountId = null;
        send('logged-out');
    }
    sendAccounts();
});

// --- Java 17 automatique (Temurin, téléchargé au premier lancement) ---
const JAVA_URL = 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse';
const javaDir = path.join(gameDirectory, 'runtime', 'java17');

function findJavaExe() {
    if (!fs.existsSync(javaDir)) return null;
    for (const entry of fs.readdirSync(javaDir)) {
        const exe = path.join(javaDir, entry, 'bin', 'java.exe');
        if (fs.existsSync(exe)) return exe;
    }
    return null;
}

function download(url, dest, onProgress, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('Trop de redirections'));

        https.get(url, { headers: { 'User-Agent': 'RadiantLauncher' } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                return resolve(download(next, dest, onProgress, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('Téléchargement impossible (HTTP ' + res.statusCode + ')'));
            }

            const total = parseInt(res.headers['content-length'] || '0', 10);
            let done = 0;
            const file = fs.createWriteStream(dest);

            res.on('data', (chunk) => {
                done += chunk.length;
                if (total) onProgress((done / total) * 100);
            });
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        }).on('error', reject);
    });
}

async function ensureJava() {
    const existing = findJavaExe();
    if (existing) return existing;

    fs.mkdirSync(javaDir, { recursive: true });
    const zipPath = path.join(javaDir, 'java17.zip');
    const label = 'Téléchargement de Java 17 (première fois)...';

    send('status', { text: label, percent: 0 });
    await download(JAVA_URL, zipPath, (percent) => {
        send('status', { text: label, percent });
    });

    send('status', { text: 'Installation de Java 17...', percent: 100 });
    new AdmZip(zipPath).extractAllTo(javaDir, true);
    fs.unlinkSync(zipPath);

    const exe = findJavaExe();
    if (!exe) throw new Error('Java 17 introuvable après installation');
    return exe;
}

// --- Lancement de Minecraft ---
ipcMain.on('launch-game', async () => {
    if (!userAuth) {
        send('status', 'Erreur : Non connecté !');
        return;
    }

    const opts = {
        authorization: userAuth,
        root: gameDirectory,
        version: {
            number: '1.20.1',
            type: 'release'
        },
        memory: {
            max: '4G',
            min: '2G'
        },
        server: "eu17-free.falixserver.net",
        port: 25565
    };

    try {
        opts.javaPath = await ensureJava();
        const proc = await launcher.launch(opts);
        if (!proc) {
            send('status', 'Erreur : impossible de lancer le jeu (voir la console).');
        }
    } catch (error) {
        console.error('Erreur de lancement :', error);
        send('status', 'Erreur : ' + ((error && error.message) || error));
    }
});
