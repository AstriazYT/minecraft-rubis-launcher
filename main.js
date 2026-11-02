const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Auth } = require('msmc');
const { Client } = require('minecraft-launcher-core');
const { autoUpdater } = require('electron-updater');

const launcher = new Client();
let mainWindow;
let userAuth = null; // Session Microsoft valide

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
        icon: path.join(__dirname, 'build/icon.ico')
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
        icon: path.join(__dirname, 'build/icon.ico')
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

// --- Connexion Microsoft (msmc v5) ---
ipcMain.on('microsoft-login', async () => {
    try {
        const authManager = new Auth('select_account');
        const xboxManager = await authManager.launch('electron');
        const token = await xboxManager.getMinecraft();

        userAuth = token.mclc();
        const username = token.profile.name;

        send('login-success', username);
    } catch (error) {
        console.error('Erreur de connexion Microsoft :', error);
        const msg = String((error && error.message) || error);

        // Fenêtre fermée par l'utilisateur
        if (msg.includes('closed')) {
            send('status', 'Erreur : connexion annulée.');
        } else {
            send('status', 'Erreur : ' + msg);
        }
    }
});

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
        }
    };

    try {
        const proc = await launcher.launch(opts);
        if (!proc) {
            send('status', 'Erreur : impossible de lancer le jeu (voir la console).');
        }
    } catch (error) {
        console.error('Erreur de lancement :', error);
        send('status', 'Erreur : ' + ((error && error.message) || error));
    }
});
