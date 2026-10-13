import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAyEIvqnVZ2qvVprwrQuG02SEauObQLDiE",
  authDomain: "isbn-scanner-4db27.firebaseapp.com",
  projectId: "isbn-scanner-4db27",
  storageBucket: "isbn-scanner-4db27.firebasestorage.app",
  messagingSenderId: "381772912751",
  appId: "1:381772912751:web:aa934e35cedb0c2b11159a"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
