const searchInput  = document.getElementById('search-input');
const searchBtn    = document.getElementById('search-btn');
const clearBtn     = document.getElementById('clear-btn');
const resultsEl    = document.getElementById('results');
const errorEl      = document.getElementById('error');
const suggestionsEl = document.getElementById('suggestions');

// Cache word IDs from autocomplete so etymology fetch skips the extra round-trip
const wordIdCache = {};
let autocompleteTimer = null;

// ── Search box events ─────────────────────────────────────────────────────────

searchBtn.addEventListener('click', search);
searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { hideSuggestions(); search(); }
    if (e.key === 'Escape') hideSuggestions();
});
clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.classList.add('hidden');
    searchInput.focus();
    hideSuggestions();
    hide(resultsEl);
    hide(errorEl);
});
searchInput.addEventListener('input', () => {
    clearBtn.classList.toggle('hidden', searchInput.value === '');
    clearTimeout(autocompleteTimer);
    const val = searchInput.value.trim();
    if (val.length < 2) { hideSuggestions(); return; }
    autocompleteTimer = setTimeout(() => loadSuggestions(val), 280);
});

// Close suggestions when clicking outside the search wrapper
document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrapper')) hideSuggestions();
});

// Suggestion item clicks
suggestionsEl.addEventListener('click', e => {
    const item = e.target.closest('.suggestion-item');
    if (!item) return;
    searchInput.value = item.dataset.word;
    clearBtn.classList.remove('hidden');
    hideSuggestions();
    search();
});

// Synonym chip clicks (event delegation — avoids inline onclick quote issues)
resultsEl.addEventListener('click', e => {
    const chip = e.target.closest('.synonym-chip');
    if (chip) searchWord(chip.dataset.word);
});

// ── Autocomplete ──────────────────────────────────────────────────────────────

async function loadSuggestions(prefix) {
    try {
        const res  = await fetch(
            `https://api.etymologyexplorer.com/prod/autocomplete?word=${enc(prefix)}&language=English`
        );
        const data = await res.json();
        const items = data.auto_complete_data || [];
        items.forEach(item => { wordIdCache[item.word.toLowerCase()] = item._id; });
        showSuggestions(items.slice(0, 7).map(i => i.word));
    } catch {
        hideSuggestions();
    }
}

function showSuggestions(words) {
    if (!words.length) { hideSuggestions(); return; }
    suggestionsEl.innerHTML = words.map(w =>
        `<div class="suggestion-item" data-word="${esc(w)}">
             <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                 <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
             </svg>
             ${esc(w)}
         </div>`
    ).join('');
    suggestionsEl.classList.remove('hidden');
}

function hideSuggestions() {
    suggestionsEl.classList.add('hidden');
    suggestionsEl.innerHTML = '';
}

// ── Main search ───────────────────────────────────────────────────────────────

async function search() {
    const word = searchInput.value.trim();
    if (!word) return;

    hideSuggestions();
    resultsEl.innerHTML = '<div class="loading-msg">Looking up&hellip;</div>';
    show(resultsEl);
    hide(errorEl);

    const [dictData, etymology, synonyms] = await Promise.all([
        fetchDictionary(word),
        fetchEtymology(word),
        fetchSynonyms(word),
    ]);

    if (dictData) { render(dictData, etymology, synonyms); return; }

    const wikiData = await fetchWikipedia(word);
    if (wikiData) { renderWiki(wikiData, etymology, synonyms); return; }

    hide(resultsEl);
    errorEl.textContent = `No results found for "${word}".`;
    show(errorEl);
}

// ── API fetchers ──────────────────────────────────────────────────────────────

async function fetchDictionary(word) {
    try {
        const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${enc(word)}`);
        if (!res.ok) return null;
        return res.json();
    } catch { return null; }
}

async function fetchWikipedia(word) {
    try {
        const res  = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(word)}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.type === 'disambiguation') return null;
        return data;
    } catch { return null; }
}

// Tries Etymology Explorer API first, falls back to Wiktionary HTML parsing.
async function fetchEtymology(word) {
    try {
        const result = await fetchEtymologyExplorer(word);
        if (result) return result;
    } catch {}
    return fetchEtymologyWiktionary(word);
}

async function fetchEtymologyExplorer(word) {
    const key = word.toLowerCase();

    // Resolve word ID — use cache if available from autocomplete
    let wordId = wordIdCache[key];
    if (!wordId) {
        const res  = await fetch(
            `https://api.etymologyexplorer.com/prod/autocomplete?word=${enc(word)}&language=English`
        );
        const data = await res.json();
        const items = data.auto_complete_data || [];
        items.forEach(i => { wordIdCache[i.word.toLowerCase()] = i._id; });
        const exact = items.find(i => i.word.toLowerCase() === key);
        wordId = exact?._id || items[0]?._id;
    }
    if (!wordId) return null;

    const treeRes  = await fetch(
        `https://api.etymologyexplorer.com/prod/get_trees?ids[]=${wordId}`
    );
    const treeData = await treeRes.json();

    // Locate words map and edges array robustly (indices 1 and 3 per API spec)
    let wordsObj = null, edges = null;
    if (Array.isArray(treeData)) {
        for (const item of treeData) {
            if (item?.words && !wordsObj) wordsObj = item.words;
            if (Array.isArray(item) && Array.isArray(item[0]) && !edges) edges = item;
        }
    }
    if (!wordsObj || !edges?.length) return null;

    return buildEtymTreeFromGraph(wordsObj, edges, word);
}

function buildEtymTreeFromGraph(wordsObj, edges, searchedWord) {
    const ids = Object.keys(wordsObj);
    if (!ids.length) return null;

    // edges: [ancestor_id, descendant_id]
    const outEdges = {}, inEdges = {};
    ids.forEach(id => { outEdges[id] = []; inEdges[id] = []; });
    edges.forEach(([from, to]) => {
        if (outEdges[from]) outEdges[from].push(to);
        if (inEdges[to])    inEdges[to].push(from);
    });

    // Root = oldest node (no ancestors)
    const rootId = ids.find(id => inEdges[id].length === 0);
    if (!rootId) return null;

    // Find the node matching the searched word (the target leaf)
    const key = searchedWord.toLowerCase();
    const targetId = ids.find(id => wordsObj[id]?.word?.toLowerCase() === key)
                  || ids.find(id => outEdges[id].length === 0); // fallback: any leaf

    // Walk the longest path from root toward targetId using BFS/DFS
    // prefer the branch that leads toward targetId where possible
    function pathTo(start, goal) {
        const visited = new Set([start]);
        const stack = [[start, [start]]];
        let best = null;
        while (stack.length) {
            const [cur, p] = stack.pop();
            if (cur === goal) return p;
            const nexts = outEdges[cur] || [];
            // prefer the child that is or leads toward goal
            for (const nxt of nexts) {
                if (!visited.has(nxt)) {
                    visited.add(nxt);
                    stack.push([nxt, [...p, nxt]]);
                    if (!best || p.length + 1 > best.length) best = [...p, nxt];
                }
            }
        }
        return best || [start];
    }

    const path = targetId ? pathTo(rootId, targetId) : (() => {
        // No target found — walk greedily to longest leaf
        const p = [rootId];
        const vis = new Set([rootId]);
        let cur = rootId;
        while (outEdges[cur]?.length && p.length < 20) {
            const next = outEdges[cur].find(n => !vis.has(n));
            if (!next) break;
            vis.add(next); p.push(next); cur = next;
        }
        return p;
    })();

    // Cognates: siblings of the final node (other children of its parent)
    const cognates = [];
    if (path.length >= 2) {
        const parentId = path[path.length - 2];
        (outEdges[parentId] || [])
            .filter(id => id !== path[path.length - 1])
            .slice(0, 2)
            .forEach(id => {
                const n = wordsObj[id];
                if (n?.language_name && n?.word)
                    cognates.push({ lang: n.language_name, word: n.word });
            });
    }

    // Ancestors = all nodes in path except the final (the searched word's node)
    const ancestors = path.slice(0, -1).map(id => {
        const n = wordsObj[id];
        return { lang: n?.language_name || '', word: n?.word || '' };
    }).filter(n => n.lang && n.word);

    if (ancestors.length < 2 && cognates.length === 0) return null;
    // Reject trees where every ancestor is plain Modern English — not a useful etymology
    const hasHistoricalAncestor = ancestors.some(a => !/^English$/i.test(a.lang));
    if (!hasHistoricalAncestor && cognates.length === 0) return null;
    return { ancestors, cognates, raw: '' };
}

// Wiktionary fallback — parses raw HTML, separates "from" chain from "cognate with"
async function fetchEtymologyWiktionary(word) {
    try {
        const res  = await fetch(
            `https://en.wiktionary.org/w/api.php?action=parse&page=${enc(word)}&prop=text&format=json&origin=*`
        );
        const data = await res.json();
        if (!data.parse) return null;

        const doc     = new DOMParser().parseFromString(data.parse.text['*'], 'text/html');
        const heading = doc.querySelector('[id^="Etymology"]');
        if (!heading) return null;

        const el = heading.closest('.mw-heading') || heading.closest('h2,h3,h4');
        if (!el) return null;

        let next = el.nextElementSibling;
        while (next) {
            if (next.classList.contains('mw-heading') || /^H[2-4]$/.test(next.tagName)) break;
            if (next.tagName === 'P' && next.textContent.trim().length > 10)
                return parseEtymParagraph(next);
            next = next.nextElementSibling;
        }
        return null;
    } catch { return null; }
}

function parseEtymParagraph(pElem) {
    const ancestors = [], cognates = [];
    let mode = 'ancestors', pendingLang = null;

    function walk(node) {
        for (const child of node.childNodes) {
            if (child.nodeType === 3) {
                if (/cognate\s+with|compare\s+with|akin\s+to/i.test(child.textContent))
                    mode = 'cognates';
            } else if (child.nodeType === 1) {
                if (child.matches('span.etyl')) {
                    pendingLang = child.textContent.trim();
                } else if (child.matches('i.mention') && pendingLang) {
                    const word = (child.querySelector('a') || child).textContent.trim();
                    if (word) {
                        (mode === 'cognates' ? cognates : ancestors).push({ lang: pendingLang, word });
                        pendingLang = null;
                    }
                } else { walk(child); }
            }
        }
    }
    walk(pElem);

    const raw = pElem.textContent.trim().replace(/\[\d+\]/g, '');
    return { ancestors: ancestors.reverse(), cognates, raw };
}

async function fetchSynonyms(word) {
    try {
        const res  = await fetch(`https://api.datamuse.com/words?rel_syn=${enc(word)}&max=14`);
        const data = await res.json();
        return data.map(w => w.word);
    } catch { return []; }
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function render(entries, etymology, synonyms) {
    const entry    = entries[0];
    const phonetic = entry.phonetic || entry.phonetics?.find(p => p.text)?.text || '';

    let h = `<div class="word-header"><span class="word-title">${esc(entry.word)}</span></div>`;
    if (phonetic) h += `<div class="phonetic">${esc(phonetic)}</div>`;

    entry.meanings.forEach((meaning, i) => {
        if (i > 0) h += '<hr class="rule">';
        h += `<div class="pos-block">
                <div class="pos-label">${esc(meaning.partOfSpeech)}</div>
                <ul class="def-list">`;
        meaning.definitions.slice(0, 6).forEach(def => {
            h += `<li>
                    <div class="def-text">${esc(def.definition)}</div>
                    ${def.example ? `<div class="def-example">${esc(def.example)}</div>` : ''}
                  </li>`;
        });
        h += `</ul></div>`;
    });

    h += sharedSections(etymology, synonyms, entry.word);
    resultsEl.innerHTML = h;
    show(resultsEl);
}

function renderWiki(wiki, etymology, synonyms) {
    const pageUrl = wiki.content_urls?.desktop?.page
        || `https://en.wikipedia.org/wiki/${enc(wiki.title)}`;
    let h = `<div class="word-header"><span class="word-title">${esc(wiki.title)}</span></div>
             <div class="wiki-source">Source: Wikipedia
                 <a class="wiki-link" href="${pageUrl}" target="_blank" rel="noopener noreferrer">View on Wikipedia &#8599;</a>
             </div>
             <hr class="rule">
             <ul class="def-list">
                 <li><div class="def-text">${esc(wiki.extract)}</div></li>
             </ul>`;
    h += sharedSections(etymology, synonyms, wiki.title);
    resultsEl.innerHTML = h;
    show(resultsEl);
}

function sharedSections(etymology, synonyms, word) {
    let h = '';

    if (etymology) {
        const etymHtml = renderEtymTree(etymology, word);
        if (etymHtml) h += `<hr class="rule"><div class="section-label">Origin</div>${etymHtml}`;
    }

    if (synonyms?.length) {
        const chips = synonyms.map(s =>
            `<button class="synonym-chip" data-word="${esc(s)}">${esc(s)}</button>`
        ).join('');
        h += `<hr class="rule">
              <div class="section-label">Synonyms</div>
              <div class="synonym-chips">${chips}</div>`;
    }

    return h;
}

// ── Etymology tree ─────────────────────────────────────────────────────────────

function renderEtymTree(etym, word) {
    if (!etym) return '';
    const { ancestors, cognates, raw } = etym;

    if (ancestors.length < 2 && cognates.length === 0) return '';

    // Branching: root node → siblings row (last ancestor + cognates) → word
    if (cognates.length > 0 && ancestors.length >= 1) {
        const root    = ancestors[0];
        const lastAnc = ancestors[ancestors.length - 1];
        const sibs    = [lastAnc, ...cognates.slice(0, 2)];

        let h = '<div class="etym-tree">';
        h += etymNodeH(root);
        h += `<div class="etym-connector"></div>`;
        h += `<div class="etym-siblings-row">`;
        sibs.forEach(n => {
            h += `<div class="etym-sib-node">
                      <span class="etym-lang">${esc(n.lang.toUpperCase())}</span>
                      <span class="etym-word">${esc(n.word)}</span>
                  </div>`;
        });
        h += `</div>`;
        h += etymArrowH();
        h += `<div class="etym-final">${esc(word)}</div></div>`;
        return h;
    }

    // Linear chain
    let h = '<div class="etym-tree">';
    ancestors.forEach((n, i) => {
        h += etymNodeH(n);
        if (i < ancestors.length - 1) h += etymArrowH();
    });
    h += etymArrowH();
    h += `<div class="etym-final">${esc(word)}</div></div>`;
    return h;
}

function etymNodeH(n) {
    return `<div class="etym-node">
                <span class="etym-lang">${esc(n.lang.toUpperCase())}</span>
                <span class="etym-word">${esc(n.word)}</span>
            </div>`;
}
function etymArrowH() { return `<div class="etym-arrow"></div>`; }

// ── Helpers ───────────────────────────────────────────────────────────────────

function searchWord(word) {
    searchInput.value = word;
    clearBtn.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    search();
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function enc(s)   { return encodeURIComponent(s); }
function esc(s)   { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
