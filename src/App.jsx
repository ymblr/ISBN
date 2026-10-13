import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { collection, deleteDoc, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { readBarcodesFromImageData } from 'zxing-wasm/reader';
import { auth, db } from './firebase';
import { lookup } from './ndl';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NDC = ['総記', '哲学・宗教', '歴史・地理', '社会科学', '自然科学', '技術・工学', '産業', '芸術・スポーツ', '言語', '文学'];
const FIELDS = [['title', 'タイトル*'], ['volume', '巻次(例: 4)'], ['author', '著者'], ['authorKana', '著者の読み(カタカナ・棚の並び用)'],
  ['publisher', '出版社'], ['isbn', 'ISBN(無ければ空欄で独自コード発行)'], ['ndc', 'NDC(例 913.6 / 大分類1桁も可)']];
const num = b => { const s = (b.ndc || '').trim(); if (!s) return 1e9; if (/^\d$/.test(s)) return s * 100; const n = parseFloat(s); return isNaN(n) ? 1e9 : n; };
const ja = (a, b) => (a || '').localeCompare(b || '', 'ja');
const kana = b => b.authorKana || b.author || '';
const mark = b => kana(b).trim().charAt(0);
const vol = b => parseFloat(b.volume) || 0;
const full = b => b.title + (b.volume ? ' ' + b.volume : '');
const byShelf = (a, b) => num(a) - num(b) || ja(mark(a), mark(b)) || ja(kana(a), kana(b)) || ja(a.title, b.title) || vol(a) - vol(b);
const SORTS = {
  ndc: byShelf, title: (a, b) => ja(a.title, b.title) || vol(a) - vol(b),
  author: (a, b) => ja(kana(a), kana(b)) || ja(a.title, b.title) || vol(a) - vol(b), new: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
};
const toIsbn13 = s => {
  s = (s || '').normalize('NFKC').replace(/[^\dXx]/g, '');
  if (/^\d{13}$/.test(s)) return s;
  if (!/^\d{9}[\dXx]$/.test(s)) return null;
  const b = '978' + s.slice(0, 9);
  return b + (10 - [...b].reduce((t, d, i) => t + +d * (i % 2 ? 3 : 1), 0) % 10) % 10;
};

// 画像を縮小してJPEGのdata URLにする(Firestoreにそのまま保存。約20KB)
const toCover = file => new Promise((ok, ng) => {
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, 300 / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = img.width * k; c.height = img.height * k;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src); ok(c.toDataURL('image/jpeg', 0.75));
  };
  img.onerror = ng; img.src = URL.createObjectURL(file);
});

// 表紙: 自分の写真/Google Books → NDL書影 → 文字だけのプレースホルダー の順に試す
function Cover({ b }) {
  const srcs = [b.cover, b.isbn && `https://ndlsearch.ndl.go.jp/thumbnail/${b.isbn}.jpg`].filter(Boolean);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [b.cover, b.isbn]);
  return i < srcs.length
    ? <img src={srcs[i]} referrerPolicy="no-referrer" onError={() => setI(i + 1)} onLoad={e => e.target.naturalWidth < 20 && setI(i + 1)} />
    : <div className="nocover">{(b.title || '表紙なし').slice(0, 8)}</div>;
}

// NDCを選んで決める: 類(1桁) → 綱(2桁) → 目(3桁)。分類表の細目は同梱せず、綱までの名称だけ持つ
const SUB = [
  '知識・学問|図書館|図書・書誌学|百科事典|論文集・雑著|逐次刊行物|団体|新聞|叢書・全集|貴重書・郷土資料',
  '哲学|哲学各論|東洋思想|西洋哲学|心理学|倫理学|宗教|神道|仏教|キリスト教',
  '歴史・世界史|日本史|アジア史|ヨーロッパ史|アフリカ史|北アメリカ史|南アメリカ史|オセアニア史|伝記|地理・紀行',
  '社会科学|政治|法律|経済|財政|統計|社会|教育|風俗習慣・民俗|国防・軍事',
  '自然科学|数学|物理学|化学|天文学|地球科学|生物学|植物学|動物学|医学・薬学',
  '技術・工学|土木|建築|機械・原子力|電気・電子|海洋・船舶|金属・鉱業|化学工業|製造工業|家政学・生活科学',
  '産業|農業|園芸|蚕糸業|畜産・獣医|林業|水産業|商業|運輸・交通|通信',
  '芸術・美術|彫刻|絵画・書道|版画・印章|写真・印刷|工芸|音楽・舞踊|演劇・映画|スポーツ・体育|諸芸・娯楽',
  '言語|日本語|中国語など|英語|ドイツ語|フランス語|スペイン語|イタリア語|ロシア語|その他の言語',
  '文学|日本文学|中国文学など|英米文学|ドイツ文学|フランス文学|スペイン文学|イタリア文学|ロシア文学|その他の文学',
].map(x => x.split('|'));
const QUICK = [['913.6', '小説'], ['726.1', '漫画'], ['914.6', 'エッセイ'], ['748', '写真集']];

function NdcPicker({ value, onChange }) {
  const v = (value || '').trim(), a = /^\d/.test(v) ? v[0] : '', b = /^\d\d/.test(v) ? v.slice(0, 2) : '', c = /^\d{3}/.test(v) ? v[2] : '0';
  return <div className="ndc">
    <input placeholder="NDC(下で選ぶと自動入力。直接入力もOK)" value={value || ''} onChange={e => onChange(e.target.value)} />
    <p>{QUICK.map(([n, l]) => <button key={n} onClick={() => onChange(n)}>{l} {n}</button>)}</p>
    <select value={a} onChange={e => onChange(e.target.value)}><option value="">① 類を選ぶ</option>
      {NDC.map((n, i) => <option key={i} value={i}>{i}00 {n}</option>)}</select>
    {a && <select value={b} onChange={e => onChange(e.target.value ? e.target.value + '0' : a)}><option value="">② 綱を選ぶ</option>
      {SUB[a].map((n, i) => <option key={i} value={a + i}>{a + i}0 {n}</option>)}</select>}
    {b && <select value={c} onChange={e => onChange(b + e.target.value)}>
      {[...Array(10).keys()].map(i => <option key={i} value={i}>③ {b}{i}</option>)}</select>}
  </div>;
}

function Login() {
  const [e, setE] = useState(''), [p, setP] = useState(''), [err, setErr] = useState('');
  const go = async ev => { ev.preventDefault(); try { await signInWithEmailAndPassword(auth, e, p); } catch (x) { setErr('ログインできません: ' + x.code); } };
  return <form onSubmit={go}><h2>ログイン</h2>
    <input type="email" placeholder="メールアドレス" value={e} onChange={x => setE(x.target.value)} />
    <input type="password" placeholder="パスワード" value={p} onChange={x => setP(x.target.value)} />
    <button className="pri">ログイン</button><p className="err">{err}</p></form>;
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
  const [view, setView] = useState('list'), [mode, setMode] = useState('scan'), [form, setForm] = useState({}), [msg, setMsg] = useState('');
  const [q, setQ] = useState(''), [sort, setSort] = useState('ndc'), [rf, setRf] = useState(''), [isbnIn, setIsbnIn] = useState('');
  const booksRef = useRef([]), codeRef = useRef();
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  useEffect(() => {
    if (!user) return;
    return onSnapshot(collection(db, 'users', user.uid, 'books'), s => {
      const l = s.docs.map(d => ({ id: d.id, ...d.data() })); booksRef.current = l; setBooks(l);
    });
  }, [user]);
  const save = (id, b) => setDoc(doc(db, 'users', user.uid, 'books', id), b, { merge: true });

  const addIsbn = async raw => {
    const isbn = toIsbn13(raw);
    if (!isbn) { setMsg('ISBNの形式が違うよ(10桁か13桁)'); return false; }
    if (booksRef.current.some(b => b.isbn === isbn)) { setMsg('登録済み: ' + isbn); return false; }
    setMsg('検索中… ' + isbn);
    try {
      const b = await lookup(isbn);
      if (!b) { setForm({ isbn }); setMode('manual'); setMsg('NDLに無い本。手入力してね'); return false; }
      await save(isbn, { ...b, isbn, createdAt: Date.now() }); setMsg('登録: ' + full(b)); return true;
    } catch (e) { setMsg('失敗: ' + e.message); return false; }
  };
  codeRef.current = async isbn => { await addIsbn(isbn); await sleep(2000); };

  const go = v => { setView(v); setMsg(''); };
  const f = k => ({ value: form[k] || '', onChange: e => setForm({ ...form, [k]: e.target.value }) });
  const saveForm = async () => {
    if (!form.title) return alert('タイトルは必須');
    const d = {}; FIELDS.forEach(([k]) => d[k] = (form[k] || '').trim());
    d.isbn = toIsbn13(d.isbn) || d.isbn;
    if (form.cover !== undefined) d.cover = form.cover;
    if (form.id) await save(form.id, d);
    else { const id = d.isbn || 'M' + Date.now().toString(36); await save(id, { ...d, code: id, source: 'manual', createdAt: Date.now() }); }
    setForm({}); go('list');
  };
  const refetch = async () => {
    setMsg('NDLから再取得中…');
    try {
      const b = await lookup(form.isbn);
      if (!b) return setMsg('NDLに見つからなかった');
      setForm({ ...form, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v)) }); setMsg('取得した内容を反映した(保存はまだ)');
    } catch (e) { setMsg('失敗: ' + e.message); }
  };
  const edit = b => { setForm({ ...b }); go('edit'); };

  if (user === undefined) return <><header>蔵書管理</header><main>読み込み中…</main></>;
  if (!user) return <><header>蔵書管理</header><main><Login /></main></>;

  const kw = q.trim().toLowerCase();
  const shown = books.filter(b => (!kw || [b.title, b.volume, b.author, b.authorKana, b.publisher, b.isbn, b.ndc].join(' ').toLowerCase().includes(kw))
    && (!rf || (rf === 'read') === !!b.read));
  const groups = [];
  [...shown].sort(byShelf).forEach(b => {
    const k = num(b) >= 1e9 ? -1 : Math.floor(num(b) / 100);
    let g = groups[groups.length - 1]; if (!g || g.k !== k) groups.push(g = { k, items: [] }); g.items.push(b);
  });
  const Form = <div className="form">
    <div className="cv"><Cover b={form} />
      <label className="btn">表紙を撮影・選択<input type="file" accept="image/*" style={{ display: 'none' }}
        onChange={async e => { const x = e.target.files[0]; if (x) setForm({ ...form, cover: await toCover(x) }); }} /></label>
      {form.cover && <button onClick={() => setForm({ ...form, cover: '' })}>表紙を外す</button>}</div>
    {FIELDS.map(([k, l]) => k === 'ndc' ? <NdcPicker key={k} value={form.ndc} onChange={v => setForm({ ...form, ndc: v })} />
      : <input key={k} placeholder={l} inputMode={k === 'isbn' ? 'numeric' : undefined} {...f(k)} />)}
    <button className="pri" onClick={saveForm}>{form.id ? '保存' : '登録'}</button>
    {form.id && <>
      {form.isbn && <button onClick={refetch}>NDLで再取得</button>}
      <button onClick={() => { go('list'); setForm({}); }}>キャンセル</button>
      <button className="del" onClick={async () => { if (confirm('この本を削除する?')) { await deleteDoc(doc(db, 'users', user.uid, 'books', form.id)); setForm({}); go('list'); } }}>削除</button></>}
  </div>;
  const Search = <p><input placeholder="検索(書名・著者・出版社・ISBN・NDC)" value={q} onChange={e => setQ(e.target.value)} /></p>;

  return <>
    <header>蔵書管理</header>
    <nav>{[['list', '一覧'], ['shelf', '本棚'], ['add', '追加'], ['user', 'ユーザー']].map(([k, l]) =>
      <button key={k} className={view === k || (k === 'add' && view === 'edit') ? 'on' : ''} onClick={() => { go(k); if (k === 'add') setForm({}); }}>{l}</button>)}</nav>
    <main>
      {msg && <p className="msg">{msg}</p>}
      {view === 'list' && <>{Search}
        <p>並び順: <select value={sort} onChange={e => setSort(e.target.value)}>
          <option value="ndc">NDC順</option><option value="title">タイトル順</option><option value="author">著者順</option><option value="new">登録が新しい順</option></select>
          {' '}<select value={rf} onChange={e => setRf(e.target.value)}><option value="">すべて</option><option value="unread">未読</option><option value="read">既読</option></select></p>
        <p>{shown.length}冊 / 全{books.length}冊(既読 {books.filter(b => b.read).length})</p>
        <table><tbody>{[...shown].sort(SORTS[sort]).map(b => <tr key={b.id}>
          <td width="44"><Cover b={b} /></td>
          <td><span className="t" onClick={() => edit(b)}>{full(b)}</span><br /><small>{b.author} {b.publisher}</small><br /><small>NDC {b.ndc || '-'} / {b.code || b.isbn}</small></td>
          <td width="50"><label><input type="checkbox" checked={!!b.read} onChange={e => save(b.id, { read: e.target.checked })} />既読</label></td></tr>)}</tbody></table></>}
      {view === 'shelf' && <><h2>本棚の並び(NDC順)</h2>{Search}
        <p><small>NDC → 著者の頭文字 → 著者 → タイトル → 巻次 の順。棚ラベルは「NDC 頭文字」。</small></p>
        {groups.map(g => <div key={g.k}><h2>{g.k < 0 ? '分類なし(NDC未設定)' : `${g.k}00 ${NDC[g.k]}`}</h2>
          <table><tbody>{g.items.map(b => <tr key={b.id}><td width="90">{b.ndc || '-'} {mark(b)}</td>
            <td><span className="t" onClick={() => edit(b)}>{full(b)}</span> <small>{b.author}</small></td></tr>)}</tbody></table></div>)}</>}
      {view === 'add' && <><h2>本を追加</h2>
        <p>{[['scan', 'バーコード'], ['isbn', 'ISBN入力'], ['manual', '手入力']].map(([k, l]) =>
          <button key={k} className={mode === k ? 'pri' : ''} onClick={() => { setMode(k); setMsg(''); }}>{l}</button>)}</p>
        {mode === 'scan' && <Scan codeRef={codeRef} />}
        {mode === 'isbn' && <p><input inputMode="numeric" placeholder="ISBN(ハイフンなしでもOK)" value={isbnIn} onChange={e => setIsbnIn(e.target.value)} />
          <button className="pri" onClick={async () => { if (await addIsbn(isbnIn)) setIsbnIn(''); }}>検索して登録</button></p>}
        {mode === 'manual' && Form}</>}
      {view === 'edit' && <><h2>本を編集</h2>{Form}</>}
      {view === 'user' && <><h2>ユーザー</h2>
        <table><tbody><tr><th>ログイン中</th><td>{user.email}</td></tr><tr><th>登録冊数</th><td>{books.length}冊</td></tr></tbody></table>
        <p><button onClick={async () => { await sendPasswordResetEmail(auth, user.email); setMsg('パスワード再設定メールを送った'); }}>パスワード再設定メールを送る</button></p>
        <p><button className="del" onClick={() => confirm('ログアウトする?') && signOut(auth)}>ログアウト</button></p></>}
    </main>
    <footer>書誌データ: 国立国会図書館サーチ(NDLサーチ)のAPIを利用</footer>
  </>;
}
