// Firestore-backed store (Firebase Admin SDK). Falls back to in-memory for local dev without credentials.
import { randomUUID } from "node:crypto";

function memoryStore() {
  const db = { sessions: new Map(), records: new Map() };
  return {
    kind: "memory",
    async create(col, data) { const id = randomUUID().slice(0, 12); const doc = { id, ...data }; db[col].set(id, doc); return doc; },
    async get(col, id) { return db[col].get(id) || null; },
    async update(col, id, patch) { const d = { ...db[col].get(id), ...patch }; db[col].set(id, d); return d; },
    async list(col) { return [...db[col].values()]; },
  };
}

async function firestoreStore() {
  const { initializeApp, applicationDefault } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT });
  const fs = getFirestore();
  fs.settings({ ignoreUndefinedProperties: true });
  return {
    kind: "firestore",
    async create(col, data) { const ref = fs.collection(col).doc(); await ref.set(data); return { id: ref.id, ...data }; },
    async get(col, id) { const s = await fs.collection(col).doc(id).get(); return s.exists ? { id: s.id, ...s.data() } : null; },
    async update(col, id, patch) { const ref = fs.collection(col).doc(id); await ref.set(patch, { merge: true }); const s = await ref.get(); return { id, ...s.data() }; },
    async list(col) { const q = await fs.collection(col).orderBy("createdAt", "desc").limit(500).get(); return q.docs.map((d) => ({ id: d.id, ...d.data() })); },
  };
}

export const store = process.env.USE_FIRESTORE === "1" ? await firestoreStore() : memoryStore();
