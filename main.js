const { app, BrowserWindow, ipcMain, safeStorage, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let splashWindow;
let tray = null;
const launcher = new Client();

// Configuration auto-updater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// Emplacement des données
const appDataPath = app.getPath('userData');
const minecraftPath = path.join(appDataPath, '.radiant-survie');
const accountsFilePath = path.join(appDataPath, 'accounts.json');

// Configuration Forge 1.20.1 & Version Java
const FORGE_VERSION = '47.3.0';
const MINECRAFT_VERSION = '1.20.1';
const JAVA_URL = 'https://corretto.aws/downloads/latest/amazon-corretto-17-x64-windows-jdk.zip';
const JAVA_DIR = path.join(appDataPath, 'java17');
const JAVA_EXE = path.join(JAVA_DIR, 'jdk17.0_x', 'bin', 'javaw.exe'); // Ajusté lors de l'extraction

// Dépôt GitHub pour les mods
const MODS_ZIP_URL = 'https://github.com/AstriazYT/minecraft-rubis-launcher/raw/main/mods.zip';

// Fonction pour envoyer des messages au front-end
function send(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

// --- Création de la fenêtre Splash ---
function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 400,
        height: 400,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    splashWindow.loadFile('splash.html');
}

// --- Création de la fenêtre Principale ---
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 950,
        height: 600,
        frame: false,
        resizable: false,
        show: false,
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');

    mainWindow.once('ready-to-show', () => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
        }
        mainWindow.show();
        checkServerStatus();
        setInterval(checkServerStatus, 30000); // Vérification du serveur toutes les 30 sec
    });
}

// --- Création du System Tray (icône à côté de l'horloge) ---
function createTray() {
    if (tray) return;
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    tray = new Tray(iconPath);
    
    const contextMenu = Menu.buildFromTemplate([
        { 
            label: 'Ouvrir Radiant Launcher', 
            click: () => {
                if (mainWindow) {
                    mainWindow.setSkipTaskbar(false);
                    mainWindow.show();
                }
            } 
        },
        { 
            label: 'Quitter', 
            click: () => app.quit() 
        }
    ]);

    tray.setToolTip('Radiant Launcher');
    tray.setContextMenu(contextMenu);

    // Double-clic sur l'icône dans la zone de notification pour réafficher la fenêtre
    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.setSkipTaskbar(false);
            mainWindow.show();
        }
    });
}

// --- Vérification du statut du serveur Falix ---
async function checkServerStatus() {
    try {
        const response = await axios.get('https://api.mcsrvstat.us/2/eu17-free.falixserver.net');
        send('server-status', {
            online: response.data.online,
            players: response.data.players ? response.data.players.online : 0,
            max: response.data.players ? response.data.players.max : 0
        });
    } catch (error) {
        send('server-status', { online: false, players: 0, max: 0 });
    }
}

// --- Téléchargement / Vérification Java 17 ---
async function ensureJava17() {
    send('status', 'Vérification de Java 17...');
    const javaExePath = path.join(JAVA_DIR, 'bin', 'javaw.exe');
    
    if (fs.existsSync(javaExePath)) {
        return javaExePath;
    }

    send('status', 'Téléchargement de Java 17...');
    const zipPath = path.join(appDataPath, 'java17.zip');
    
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(zipPath);
        https.get(JAVA_URL, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', reject);
    });

    send('status', 'Extraction de Java 17...');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(JAVA_DIR, true);
    fs.unlinkSync(zipPath);

    // Repérer le sous-dossier extrait (ex: jdk-17.0.x)
    const files = fs.readdirSync(JAVA_DIR);
    const subDir = files.find(f => fs.statSync(path.join(JAVA_DIR, f)).isDirectory());
    if (subDir) {
        const actualJavaPath = path.join(JAVA_DIR, subDir, 'bin', 'javaw.exe');
        return actualJavaPath;
    }

    return javaExePath;
}

// --- Synchronisation des Mods ---
async function syncMods() {
    send('status', 'Vérification des mods...');
    const modsDir = path.join(minecraftPath, 'mods');
    fs.ensureDirSync(modsDir);

    const zipPath = path.join(appDataPath, 'mods.zip');
    try {
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(zipPath);
            https.get(MODS_ZIP_URL, (response) => {
                if (response.statusCode === 200) {
                    response.pipe(file);
                    file.on('finish', () => file.close(resolve));
                } else {
                    reject('Impossible de récupérer les mods');
                }
            }).on('error', reject);
        });

        send('status', 'Mise à jour des mods...');
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(modsDir, true);
        fs.unlinkSync(zipPath);
    } catch (e) {
        send('status', 'Erreur de synchro des mods, lancement avec les mods existants.');
    }
}

// --- Gestion des Comptes ---
function loadAccounts() {
    if (!fs.existsSync(accountsFilePath)) return { accounts: [], lastUsed: null };
    try {
        return fs.readJsonSync(accountsFilePath);
    } catch (e) {
        return { accounts: [], lastUsed: null };
    }
}

function saveAccounts(data) {
    fs.writeJsonSync(accountsFilePath, data);
}

// --- Événements IPC ---
app.whenReady().then(() => {
    createSplashWindow();
    setTimeout(createMainWindow, 2000);
});

// Fenêtre réduire / fermer
ipcMain.on('minimize-window', () => mainWindow?.minimize());
ipcMain.on('close-window', () => mainWindow?.close());

// Demande de liste de comptes
ipcMain.on('get-accounts', (event) => {
    const data = loadAccounts();
    event.reply('accounts', data);
    
    if (data.lastUsed) {
        const acc = data.accounts.find(a => a.id === data.lastUsed);
        if (acc) {
            event.reply('login-success', acc);
        }
    }
});

// Connexion Microsoft (MSMC)
ipcMain.on('microsoft-login', async () => {
    try {
        const authManager = new Auth("select_account");
        const xboxManager = await authManager.launch("raw");
        const token = await xboxManager.getMinecraft();

        const accountData = {
            id: token.profile.id,
            name: token.profile.name,
            token: safeStorage.isEncryptionAvailable() 
                ? safeStorage.encryptString(token.mclc().access_token).toString('hex') 
                : token.mclc().access_token
        };

        const store = loadAccounts();
        const index = store.accounts.findIndex(a => a.id === accountData.id);
        if (index >= 0) store.accounts[index] = accountData;
        else store.accounts.push(accountData);
        
        store.lastUsed = accountData.id;
        saveAccounts(store);

        send('login-success', accountData);
        send('accounts', store);
    } catch (error) {
        send('status', 'Erreur lors de la connexion Microsoft.');
    }
});

// Choix ou suppression de compte
ipcMain.on('select-account', (event, id) => {
    const store = loadAccounts();
    const acc = store.accounts.find(a => a.id === id);
    if (acc) {
        store.lastUsed = id;
        saveAccounts(store);
        event.reply('login-success', acc);
    }
});

ipcMain.on('remove-account', (event, id) => {
    const store = loadAccounts();
    store.accounts = store.accounts.filter(a => a.id !== id);
    if (store.lastUsed === id) store.lastUsed = null;
    saveAccounts(store);
    event.reply('logged-out');
    event.reply('accounts', store);
});

// --- Lancement du jeu ---
ipcMain.on('launch-game', async (event, ramSetting) => {
    try {
        const store = loadAccounts();
        const acc = store.accounts.find(a => a.id === store.lastUsed);
        if (!acc) return send('status', 'Veuillez vous connecter.');

        const javaPath = await ensureJava17();
        await syncMods();

        let token = acc.token;
        if (safeStorage.isEncryptionAvailable()) {
            token = safeStorage.decryptString(Buffer.from(acc.token, 'hex'));
        }

        const opts = {
            clientPackage: null,
            authorization: Authenticator.getAuth({
                access_token: token,
                client_token: acc.id,
                uuid: acc.id,
                name: acc.name,
                user_properties: '{}'
            }),
            root: minecraftPath,
            javaPath: javaPath,
            version: {
                number: MINECRAFT_VERSION,
                type: 'release'
            },
            forge: FORGE_VERSION,
            memory: {
                max: ramSetting || '4G',
                min: '2G'
            },
            quickPlay: {
                type: 'multiplayer',
                identifier: 'eu17-free.falixserver.net'
            }
        };

        send('status', 'Lancement de Minecraft...');

        // Intégration du System Tray lors du lancement
        createTray();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.hide();
            mainWindow.setSkipTaskbar(true); // Retire l'icône de la barre des tâches principale
        }

        const proc = await launcher.launch(opts);

        launcher.on('debug', (e) => console.log(e));
        launcher.on('data', (e) => console.log(e));

        launcher.on('progress', (e) => {
            send('status', { text: `Téléchargement : ${e.type}`, percent: (e.task / e.total) * 100 });
        });

        // Réapparition de la fenêtre une fois le jeu fermé
        launcher.on('close', () => {
            send('game-closed');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.setSkipTaskbar(false);
                mainWindow.show();
            }
        });

    } catch (err) {
        console.error(err);
        send('status', 'Erreur lors du lancement.');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setSkipTaskbar(false);
            mainWindow.show();
        }
    }
});

// --- Auto Updater (Mise à jour du launcher via la flèche) ---
ipcMain.on('check-for-updates', () => {
    send('status', 'Recherche de mise à jour...');
    autoUpdater.checkForUpdatesAndNotify();
});

autoUpdater.on('update-available', () => {
    send('status', 'Téléchargement de la mise à jour...');
    autoUpdater.downloadUpdate();
});

autoUpdater.on('update-not-available', () => {
    send('status', 'Votre launcher est à jour !');
});

autoUpdater.on('update-downloaded', () => {
    send('status', 'Mise à jour prête ! Redémarrage...');
    setTimeout(() => {
        autoUpdater.quitAndInstall();
    }, 3000);
});

autoUpdater.on('error', (err) => {
    send('status', 'Erreur lors de la recherche de mise à jour.');
});

// Quitter l'application
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
