const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Auth } = require('msmc'); // Correction point 1
const { Client } = require('minecraft-launcher-core');

const launcher = new Client();
let mainWindow;
let userAuth = null;

const gameDirectory = path.join(process.env.APPDATA, '.radiant-survie');

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

// --- 1. CONNEXION MICROSOFT (Syntaxe msmc v5) ---
ipcMain.on('microsoft-login', async (event) => {
    try {
        const authManager = new Auth("select_account");
        const xboxManager = await authManager.launch("electron");
        
        if (!xboxManager) {
            mainWindow.webContents.send('status', "Connexion annulée.");
            return;
        }

        const token = await xboxManager.getMinecraft();
        userAuth = token.mclc();
        const username = token.profile.name;

        mainWindow.webContents.send('login-success', username);

    } catch (error) {
        console.error("Erreur de connexion Microsoft :", error);
        mainWindow.webContents.send('status', "Erreur : " + (error.message || error));
    }
});

// --- 5. ÉVÉNEMENTS DU LAUNCHER (Placés en dehors pour ne pas les dupliquer) ---
launcher.on('debug', (e) => console.log(e));

launcher.on('progress', (e) => {
    const percentage = (e.task / e.total) * 100;
    mainWindow.webContents.send('status', {
        text: `Téléchargement : ${e.type}`,
        percent: percentage
    });
});

launcher.on('data', (e) => {
    mainWindow.webContents.send('status', "Jeu en cours d'exécution...");
});

// --- LANCEMENT DE MINECRAFT ---
ipcMain.on('launch-game', async () => {
    if (!userAuth) {
        mainWindow.webContents.send('status', "Erreur : Non connecté !");
        return;
    }

    const opts = {
        authorization: userAuth,
        root: gameDirectory,
        version: {
            number: "1.20.1",
            type: "release"
        },
        memory: {
            max: "4G",
            min: "2G"
        }
    };

    try {
        launcher.launch(opts);
    } catch (err) {
        console.error("Erreur de lancement :", err);
        mainWindow.webContents.send('status', "Erreur au lancement du jeu");
    }
});
