import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { collection, deleteDoc, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { readBarcodesFromImageData } from 'zxing-wasm/reader';
import { auth, db } from './firebase';
import { lookup } from './ndl';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NDC = '0 総記,1 哲学,2 歴史,3 社会科学,4 自然科学,5 技術,6 産業,7 芸術,8 言語,9 文学'.split(',');
const num = b => { const n = parseFloat(b.ndc); return isNaN(n) ? 1e9 : n; };
const cmp = (a, b) => num(a) - num(b) || (a.author || '').localeCompare(b.author || '', 'ja') || (a.title || '').localeCompare(b.title || '', 'ja');

function Login() {
  const [e, setE] = useState(''), [p, setP] = useState(''), [err, setErr] = useState('');
  const go = async ev => { ev.preventDefault(); try { await signInWithEmailAndPassword(auth, e, p); } catch (x) { setErr(x.code); } };
  return <form className="c" onSubmit={go}><h1>蔵書管理</h1>
    <input type="email" placeholder="メール" value={e} onChange={x => setE(x.target.value)} />
    <input type="password" placeholder="パスワード" value={p} onChange={x => setP(x.target.value)} />
    <button>ログイン</button><p className="err">{err}</p></form>;
}

function Scan({ codeRef }) {
  const vref = useRef();
  useEffect(() => {
    let stop = false, stream;
    (async () => {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      const v = vref.current; v.srcObject = stream; await v.play();
      const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
      while (!stop) {
        const w = v.videoWidth, h = Math.round(v.videoHeight * 0.6);
        if (w) {
          c.width = w; c.height = h;
          x.drawImage(v, 0, v.videoHeight * 0.2, w, h, 0, 0, w, h);
          const r = await readBarcodesFromImageData(x.getImageData(0, 0, w, h), { formats: ['EAN13'], tryHarder: true });
          const t = r.map(q => q.text).find(s => /^97[89]\d{10}$/.test(s));
          if (t) await codeRef.current(t); // 検索・保存が終わるまで次を読まない(同時アクセス防止)
        }
        await sleep(80);
      }
    })().catch(err => alert('カメラ起動に失敗: ' + err.message));
    return () => { stop = true; stream?.getTracks().forEach(t => t.stop()); };
  }, []);
  return <div className="cam"><video ref={vref} playsInline muted /><div className="guide" /></div>;
}

export default function App() {
  const [user, setUser] = useState(undefined), [books, setBooks] = useState([]);
  const [view, setView] = useState('list'), [form, setForm] = useState({}), [msg, setMsg] = useState('');
  const booksRef = useRef([]), codeRef = useRef();
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  useEffect(() => {
    if (!user) return;
    return onSnapshot(collection(db, 'users', user.uid, 'books'), s => {
      const l = s.docs.map(d => ({ id: d.id, ...d.data() })); booksRef.current = l; setBooks(l);
    });
  }, [user]);
  const save = (id, b) => setDoc(doc(db, 'users', user.uid, 'books', id), { ...b, createdAt: Date.now() });

  codeRef.current = async isbn => {
    if (booksRef.current.some(b => b.isbn === isbn)) { setMsg('登録済み: ' + isbn); return sleep(2000); }
    setMsg('検索中… ' + isbn);
    try {
      const b = await lookup(isbn);
      if (!b) { setForm({ isbn }); setView('manual'); setMsg('NDLに無い本。手入力してね'); return; }
      await save(isbn, { ...b, isbn }); setMsg('登録: ' + b.title);
    } catch (e) { setMsg('失敗: ' + e.message); }
    await sleep(2000);
  };

  if (user === undefined) return <p className="c">読み込み中…</p>;
  if (!user) return <Login />;
  const f = k => ({ value: form[k] || '', onChange: e => setForm({ ...form, [k]: e.target.value }) });
  const saveManual = async () => {
    if (!form.title) return alert('タイトルは必須');
    const id = form.isbn || 'M' + Date.now().toString(36); // ISBNが無い本は独自コードを発行
    await save(id, { ...form, isbn: form.isbn || '', code: id, source: 'manual' });
    setForm({}); setView('list'); setMsg('');
  };

  return <div className="app">
    <nav>{[['list', '一覧'], ['scan', 'スキャン'], ['manual', '手入力']].map(([k, l]) =>
      <button key={k} className={view === k ? 'on' : ''} onClick={() => { setView(k); setMsg(''); }}>{l}</button>)}
      <button onClick={() => signOut(auth)}>ログアウト</button></nav>
    {msg && <p className="msg">{msg}</p>}
    {view === 'scan' && <Scan codeRef={codeRef} />}
    {view === 'manual' && <div className="form">
      <input placeholder="タイトル*" {...f('title')} /><input placeholder="著者" {...f('author')} />
      <input placeholder="出版社" {...f('publisher')} /><input placeholder="ISBN(無ければ空欄で独自コード発行)" inputMode="numeric" {...f('isbn')} />
      <input list="ndc" placeholder="NDC(例 913.6 / 分からなければ大分類1桁)" {...f('ndc')} />
      <datalist id="ndc">{NDC.map(s => { const [v, l] = s.split(' '); return <option key={v} value={v}>{l}</option>; })}</datalist>
      <button onClick={saveManual}>登録</button></div>}
    {view === 'list' && <><p className="n">{books.length}冊(NDC順)</p>
      <ul>{[...books].sort(cmp).map(b => <li key={b.id}>
        {b.isbn && <img src={`https://ndlsearch.ndl.go.jp/thumbnail/${b.isbn}.jpg`} onError={e => e.target.style.visibility = 'hidden'} />}
        <div><b>{b.title}</b><small>{b.author} {b.publisher}</small><small>NDC {b.ndc || '-'}{b.code ? ` / ${b.code}` : ''}</small></div>
        <button onClick={() => confirm('削除する?') && deleteDoc(doc(db, 'users', user.uid, 'books', b.id))}>×</button></li>)}</ul></>}
    <footer>書誌データ: 国立国会図書館サーチ(NDLサーチ)のAPIを利用</footer>
  </div>;
}
