// Firebase bootstrap: app init, anonymous auth, exported db handle.
//
// This file holds the web config and nothing else about the game. The config is public
// by design and is committed deliberately — see README "Why the Firebase config is in
// the repo". database.rules.json is the only thing protecting the data.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getDatabase,
  connectDatabaseEmulator,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js';

// ---------------------------------------------------------------------------
// Public by design — see README "Why the Firebase config is in the repo".
// This is NOT a secret; database.rules.json is what protects the data.
//
// NOTE: this project (would-you-rather-e18fb) is shared with another app. The rules in
// this repo govern the whole Realtime Database instance, not just /rooms.
// ---------------------------------------------------------------------------
const firebaseConfig = {
  apiKey: 'AIzaSyCnO5p0OooCetRQK65YH6B8uddg1eTCPsg',
  authDomain: 'would-you-rather-e18fb.firebaseapp.com',
  databaseURL: 'https://would-you-rather-e18fb-default-rtdb.firebaseio.com',
  projectId: 'would-you-rather-e18fb',
  storageBucket: 'would-you-rather-e18fb.firebasestorage.app',
  messagingSenderId: '792721368038',
  appId: '1:792721368038:web:a8884afb7ccf7fb8da2c27',
};

// Emulator mode is opt-in via ?emu=1 and sticks for the tab, so host.html and play.html
// stay on the same backend as you navigate. It is deliberately NOT keyed off hostname:
// the intended topology (README §9.4) has the host on localhost and players on
// github.io, and a hostname check would silently split them across two databases.
const params = new URLSearchParams(location.search);
if (params.has('emu')) sessionStorage.setItem('wt_emu', params.get('emu') === '1' ? '1' : '0');
export const USE_EMULATOR = sessionStorage.getItem('wt_emu') === '1';

const EMULATOR_HOST = location.hostname || '127.0.0.1';

const app = initializeApp(
  USE_EMULATOR
    ? // The namespace MUST be "<project>-default-rtdb". The emulator applies
      // database.rules.json only to the default namespace; any other name silently gets
      // wide-open rules, which would make local testing worthless.
      {
        ...firebaseConfig,
        apiKey: 'emulator-key',
        projectId: 'whose-tiktok-dev',
        databaseURL: `http://${EMULATOR_HOST}:9000/?ns=whose-tiktok-dev-default-rtdb`,
      }
    : firebaseConfig
);

export const auth = getAuth(app);
export const db = getDatabase(app);

if (USE_EMULATOR) {
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
  connectDatabaseEmulator(db, EMULATOR_HOST, 9000);
  console.info('[firebase] EMULATOR MODE — auth :9099, db :9000');
}

/**
 * Resolves with the signed-in anonymous uid. Safe to await from every controller;
 * repeated calls share one sign-in.
 */
let readyPromise = null;
export function authReady() {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    onAuthStateChanged(
      auth,
      (user) => {
        if (user) resolve(user.uid);
      },
      reject
    );
    signInAnonymously(auth).catch((err) => {
      // The overwhelmingly common cause is the deploy domain missing from
      // Authentication -> Settings -> Authorized domains. The raw error does not say so.
      console.error('[firebase] anonymous sign-in failed:', err.code, err.message);
      reject(
        new Error(
          `Anonymous sign-in failed (${err.code}). Check that Anonymous auth is enabled and that this domain ` +
            `(${location.hostname}) is in Firebase Console -> Authentication -> Settings -> Authorized domains.`
        )
      );
    });
  });
  return readyPromise;
}
