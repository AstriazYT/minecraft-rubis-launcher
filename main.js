const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Auth } = require('msmc');
const { Client } = require('minecraft-launcher-core');

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

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 600,
        frame: false,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'build/icon.ico')
    });

    mainWindow.loadFile('index.html');
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