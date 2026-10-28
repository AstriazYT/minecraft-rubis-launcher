const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const msmc = require('msmc'); // Gestionnaire de connexion Microsoft corrigé
const Launcher = require('minecraft-launcher-core');

const launcher = new Launcher();
let mainWindow;
let userAuth = null; // Stockera la session Microsoft valide

// 1. Définition d'un dossier propre pour le jeu dans AppData
const gameDirectory = path.join(process.env.APPDATA, '.radiant-survie');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 600,
        frame: false, // Windowless personnalisé
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'build/icon.ico') // Icône de la fenêtre
    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- 2. GESTION DE LA VRAIE CONNEXION MICROSOFT ---
ipcMain.on('microsoft-login', async (event) => {
    try {
        // Ouvre la vraie fenêtre de connexion Microsoft avec msmc
        const xboxManager = await msmc.fastAuth("electron", {
            options: {
                prompt: "select_account"
            }
        });

        if (!xboxManager) {
            mainWindow.webContents.send('status', "Connexion annulée.");
            return;
        }

        const token = await xboxManager.getMinecraft();

        // Stocke la session d'authentification valide
        userAuth = token.mclc();

        // Récupère le pseudo du joueur
        const username = token.profile.name;

        // Envoie la confirmation de réussite à index.html
        mainWindow.webContents.send('login-success', username);

    } catch (error) {
        console.error("Erreur de connexion Microsoft :", error);
        mainWindow.webContents.send('status', "Erreur de connexion Microsoft !");
    }
});

// --- 3. LANCEMENT DE MINECRAFT ---
ipcMain.on('launch-game', async () => {
    if (!userAuth) {
        mainWindow.webContents.send('status', "Erreur : Non connecté !");
        return;
    }

    const opts = {
        authorization: userAuth,
        root: gameDirectory, // Dossier propre dans AppData/.radiant-survie
        version: {
            number: "1.20.1",
            type: "release"
        },
        memory: {
            max: "4G",
            min: "2G"
        }
    };

    launcher.launch(opts);

    launcher.on('debug', (e) => console.log(e));
    
    launcher.on('progress', (e) => {
        // Envoie la vraie progression (pourcentage + état) à index.html
        const percentage = (e.task / e.total) * 100;
        mainWindow.webContents.send('status', {
            text: `Téléchargement : ${e.type}`,
            percent: percentage
        });
    });

    launcher.on('data', (e) => {
        mainWindow.webContents.send('status', "Jeu en cours d'exécution...");
    });
});