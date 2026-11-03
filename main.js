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
let userAuth = null;
let currentAccountId = null;

// Dossier de jeu propre dans AppData/Roaming
const gameDirectory = path.join(app.getPath('appData'), '.radiant-survie');
const modsDirectory = path.join(gameDirectory, 'mods');

function send(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

let splashWindow;

// --- Mises à jour automatiques du Launcher ---
function setupAutoUpdate() {
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = true;

    autoUpdater.on('update-available', (info) => {
        send('status', `Mise à jour ${info.version} : téléchargement...`);
    });

    autoUpdater.on('download-progress', (p) => {
        send('status', {
            text: 'Téléchargement de la mise à jour du launcher...',
            percent: p.percent
        });
    });

    autoUpdater.on('update-downloaded', () => {
        send('status', 'Mise à jour prête, redémarrage...');
        setTimeout(() => autoUpdater.quitAndInstall(), 2000);
    });

    autoUpdater.checkForUpdates().catch((err) => console.error(err));
}

function createWindow() {
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

    const minDelay = new Promise((resolve) => setTimeout(resolve, 2500));
    const mainReady = new Promise((resolve) => mainWindow.once('ready-to-show', resolve));

    Promise.all([minDelay, mainReady]).then(() => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        mainWindow.show();
        setupAutoUpdate();
        checkServerStatus(); // Vérification initiale du statut du serveur
        // Actualiser le statut du serveur toutes les 60 secondes
        setInterval(checkServerStatus, 60000);
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- Fenêtre ---
ipcMain.on('minimize-window', () => mainWindow && mainWindow.minimize());
ipcMain.on('close-window', () => mainWindow && mainWindow.close());

// --- Statut du serveur Falix (API Minecraft Ping) ---
function checkServerStatus() {
    const serverData = JSON.stringify({
        host: "eu17-free.falixserver.net",
        port: 25565
    });

    const req = https.request({
        hostname: 'api.mcsrvstat.us',
        path: '/3/eu17-free.falixserver.net',
        method: 'GET'
    }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            try {
                const result = JSON.parse(data);
                if (result.online) {
                    send('server-status', {
                        online: true,
                        players: result.players.online,
                        max: result.players.max
                    });
                } else {
                    send('server-status', { online: false });
                }
            } catch (e) {
                send('server-status', { online: false });
            }
        });
    });

    req.on('error', () => send('server-status', { online: false }));
    req.end();
}

ipcMain.on('check-server', () => checkServerStatus());

// --- Comptes Microsoft ---
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
    if (!safeStorage.isEncryptionAvailable()) return null;
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
    if (!account) return;
    try {
        const xboxManager = await newAuth().refresh(decryptToken(account.token));
        await finishLogin(xboxManager);
    } catch (error) {
        userAuth = null;
        currentAccountId = null;
        send('status', 'Session expirée, reconnecte ton compte.');
    }
}

ipcMain.on('get-accounts', () => {
    const store = loadAccounts();
    sendAccounts();
    if (store.lastUsed && store.accounts.some((a) => a.id === store.lastUsed)) {
        loginWithSaved(store.lastUsed);
    }
});

ipcMain.on('microsoft-login', async () => {
    try {
        const xboxManager = await newAuth().launch('electron');
        await finishLogin(xboxManager);
    } catch (error) {
        send('status', 'Connexion annulée ou erreur.');
    }
});

ipcMain.on('select-account', (event, id) => loginWithSaved(id));

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

// --- Java 17 ---
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
                return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
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
    send('status', { text: 'Téléchargement de Java 17...', percent: 0 });
    await download(JAVA_URL, zipPath, (percent) => send('status', { text: 'Téléchargement de Java 17...', percent }));
    new AdmZip(zipPath).extractAllTo(javaDir, true);
    fs.unlinkSync(zipPath);
    return findJavaExe();
}

// --- Synchronisation et Mise à Jour Automatique des Mods ---
async function ensureMods() {
    fs.mkdirSync(modsDirectory, { recursive: true });

    // Liste des mods synchronisés avec GitHub (si tu remplaces un jar sur GitHub, il se mettra à jour chez les joueurs)
    const modsList = [
        {
            name: 'fancymenu_forge_3.8.1_MC_1.20.1.jar',
            url: 'https://raw.githubusercontent.com/AstriazYT/minecraft-rubis-launcher/main/mods/fancymenu_forge_3.8.1_MC_1.20.1.jar'
        },
        {
            name: 'cloth-config-12.0.109-forge.jar',
            url: 'https://raw.githubusercontent.com/AstriazYT/minecraft-rubis-launcher/main/mods/cloth-config-12.0.109-forge.jar'
        }
    ];

    for (const mod of modsList) {
        const destPath = path.join(modsDirectory, mod.name);
        try {
            // Télécharge ou remplace si absent
            if (!fs.existsSync(destPath)) {
                send('status', { text: `Téléchargement du mod ${mod.name}...`, percent: 30 });
                await download(mod.url, destPath, () => {});
            }
        } catch (err) {
            console.error(`Erreur mod ${mod.name}:`, err);
        }
    }
}

// --- Lancement du Jeu ---
ipcMain.on('launch-game', async (event, userRam) => {
    if (!userAuth) {
        send('status', 'Erreur : Non connecté !');
        return;
    }

    try {
        send('status', { text: 'Vérification des mods...', percent: 10 });
        await ensureMods();

        // Correctif JSON Forge
        const versionFolder = path.join(gameDirectory, 'versions', '1.20.1-forge-47.2.0');
        const badJson = path.join(versionFolder, '1.20.1.json');
        const correctJson = path.join(versionFolder, '1.20.1-forge-47.2.0.json');
        if (fs.existsSync(badJson) && !fs.existsSync(correctJson)) {
            try { fs.renameSync(badJson, correctJson); } catch (e) {}
        }

        // RAM allouée (par défaut 4G si non spécifiée par le joueur)
        const ramAllocation = userRam || '4G';

        const opts = {
            authorization: userAuth,
            root: gameDirectory,
            version: {
                number: '1.20.1',
                type: 'release',
                custom: '1.20.1-forge-47.2.0'
            },
            memory: {
                max: ramAllocation,
                min: '2G'
            },
            server: "eu17-free.falixserver.net",
            port: 25565,
            quickPlay: {
                type: "multiplayer",
                identifier: "eu17-free.falixserver.net:25565"
            }
        };

        opts.javaPath = await ensureJava();
        const proc = await launcher.launch(opts);
        if (!proc) {
            send('status', 'Erreur : impossible de lancer le jeu.');
        }
    } catch (error) {
        console.error(error);
        send('status', 'Erreur : ' + error.message);
    }
});
