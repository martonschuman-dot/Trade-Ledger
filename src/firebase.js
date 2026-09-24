import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Not secret: this only identifies the Firebase project.
// Your data is protected by the Firestore security rules.
const firebaseConfig = {
  apiKey: "AIzaSyAsexEtyU3JKIYqS0L44cTRTD53oo3A8jk",
  authDomain: "trade-ledger-b5cab.firebaseapp.com",
  projectId: "trade-ledger-b5cab",
  storageBucket: "trade-ledger-b5cab.firebasestorage.app",
  messagingSenderId: "906378773133",
  appId: "1:906378773133:web:78466141d13e0f7cdd18c4",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);
