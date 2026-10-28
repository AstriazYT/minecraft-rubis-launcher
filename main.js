const { app, BrowserWindow, ipcMain } = require('electron');
const { Client, Authenticator } = require('minecraft-launcher-core');
const path = require('path');
const axios = require('axios');

let mainWindow;
let cachedAuth = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    frame: false,
    webPreferences: { 
      nodeIntegration: true, 
      contextIsolation: false 
    }
  });
  win.loadFile('index.html');
  return win;
}

app.whenReady().then(() => {
  mainWindow = createWindow();

  // Étape 1 : Authentification Microsoft Officielle
  ipcMain.on('microsoft-login', async () => {
    try {
      mainWindow.webContents.send('status', { text: 'Connexion à Microsoft...' });
      cachedAuth = await Authenticator.getAuth("microsoft");
      mainWindow.webContents.send('login-success', cachedAuth.name);
    } catch (error) {
      console.error(error);
      mainWindow.webContents.send('status', { text: 'Échec de la connexion Microsoft.' });
    }
  });

  // Étape 2 : Téléchargement Forge/Mods & Lancement vers radiant.falix.me
  ipcMain.on('launch-game', async () => {
    try {
      mainWindow.webContents.send('status', { text: 'Vérification des mises à jour...', percent: 0 });
      
      const response = await axios.get('https://astriaz.github.io/minecraft-launcher-files/versions/1.20.1/config.json');
      const remoteConfig = response.data;

      mainWindow.webContents.send('status', { text: 'Téléchargement de Forge et des mods...', percent: 20 });
      const launcher = new Client();
      
      const opts = {
        authorization: cachedAuth,
        root: path.join(app.getPath('userData'), 'game_files'),
        version: {
          number: remoteConfig.gameVersion,
          type: "release"
        },
        forge: remoteConfig.forgeVersionPath,
        memory: {
          max: "4G",
          min: "2G"
        },
        server: {
          host: "radiant.falix.me",
          port: 25565
        }
      };

      launcher.on('progress', (e) => {
        mainWindow.webContents.send('status', {
          text: 'Installation des fichiers de Radiant...',
          percent: e.percent
        });
      });

      await launcher.launch(opts);
      mainWindow.webContents.send('status', { text: 'Lancement de Radiant !', percent: 100 });

    } catch (error) {
      console.error(error);
      mainWindow.webContents.send('status', { text: 'Erreur au lancement du jeu.', percent: 0 });
    }
  });
});
