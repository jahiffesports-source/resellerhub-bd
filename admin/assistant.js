// ResellerHub BD - Admin AI Assistant v3 (Smart Brain + Vision)
(function() {
    'use strict';
    var css = document.createElement('style');
    css.textContent = [
        '.rhai-btn{position:fixed;bottom:22px;right:22px;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:white;border:none;cursor:pointer;font-size:1.5rem;box-shadow:0 6px 20px rgba(109,40,217,0.4);z-index:9000;}',
        '.rhai-btn:hover{transform:scale(1.08);}',
        '.rhai-panel{position:fixed;bottom:95px;right:22px;width:380px;max-width:calc(100vw - 40px);height:540px;max-height:calc(100vh - 130px);background:white;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,0.25);z-index:9001;display:none;flex-direction:column;overflow:hidden;}',
        '.rhai-panel.open{display:flex;}',
        '.rhai-head{background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:white;padding:14px 18px;display:flex;align-items:center;gap:10px;}',
        '.rhai-head .av{width:38px;height:38px;background:rgba(255,255,255,0.25);border-radius:50%;display:flex;align-items:center;justify-content:center;}',
        '.rhai-head h4{font-size:0.95rem;margin:0;}',
        '.rhai-head small{opacity:0.85;font-size:0.7rem;display:block;}',
        '.rhai-head .cls{margin-left:auto;background:none;border:none;color:white;font-size:1.3rem;cursor:pointer;}',
        '.rhai-msgs{flex:1;overflow-y:auto;padding:14px;background:#f8fafc;display:flex;flex-direction:column;gap:8px;}',
        '.rhai-msg{max-width:88%;padding:10px 14px;border-radius:14px;font-size:0.86rem;line-height:1.6;word-break:break-word;white-space:pre-line;}',
        '.rhai-msg.bot{background:white;border:1px solid #e2e8f0;align-self:flex-start;}',
        '.rhai-msg.user{background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:white;align-self:flex-end;}',
        '.rhai-msg img.att{max-width:120px;border-radius:8px;display:block;margin-top:6px;}',
        '.rhai-msg .lnk{color:#6d28d9;font-weight:700;text-decoration:none;}',
        '.rhai-chips{display:flex;gap:6px;flex-wrap:wrap;padding:0 14px 8px;background:#f8fafc;}',
        '.rhai-chip{font-size:0.72rem;padding:5px 12px;border-radius:20px;border:1px solid #ddd6fe;background:white;color:#6d28d9;cursor:pointer;font-weight:600;}',
        '.rhai-input{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #e2e8f0;background:white;align-items:center;}',
        '.rhai-input input[type=text]{flex:1;padding:10px 14px;border:1.5px solid #e2e8f0;border-radius:20px;font-size:0.88rem;outline:none;}',
        '.rhai-att{background:#f1f5f9;border:none;width:38px;height:38px;border-radius:50%;cursor:pointer;color:#6d28d9;}',
        '.rhai-att.has{background:#d1fae5;color:#059669;}',
        '.rhai-send{background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:white;border:none;width:38px;height:38px;border-radius:50%;cursor:pointer;}',
        '@media(max-width:480px){.rhai-panel{bottom:80px;right:12px;left:12px;width:auto;}}'
    ].join('');
    document.head.appendChild(css);

    var wrap = document.createElement('div');
    wrap.innerHTML =
        '<button class="rhai-btn" id="rhaiBtn"><i class="fas fa-robot"></i></button>' +
        '<div class="rhai-panel" id="rhaiPanel">' +
        '<div class="rhai-head"><div class="av"><i class="fas fa-robot"></i></div><div><h4>RH Smart Assistant</h4><small>Think + See + Do</small></div><button class="cls" id="rhaiCls">&times;</button></div>' +
        '<div class="rhai-msgs" id="rhaiMsgs"></div>' +
        '<div class="rhai-chips" id="rhaiChips"></div>' +
        '<div class="rhai-input">' +
        '<input type="file" id="rhaiFile" accept="image/*" multiple style="display:none;">' +
        '<button class="rhai-att" id="rhaiAtt" title="Attach image"><i class="fas fa-paperclip"></i></button>' +
        '<input type="text" id="rhaiText" placeholder="Kichu likhun or attach image...">' +
        '<button class="rhai-send" id="rhaiSend"><i class="fas fa-paper-plane"></i></button>' +
        '</div></div>';
    document.body.appendChild(wrap);

    function $(id) { return document.getElementById(id); }
    var mem = { flow: null, title: '', images: [] };
    function dbGet(k) { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; } }
    function dbSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
    function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
    function addMsg(html, who) { var d = document.createElement('div'); d.className = 'rhai-msg ' + who; d.innerHTML = html; $('rhaiMsgs').appendChild(d); $('rhaiMsgs').scrollTop = $('rhaiMsgs').scrollHeight; }
    function bot(t) { addMsg(t, 'bot'); }
    function link(p, l) { return '<a class="lnk" href="' + p + '">' + l + ' &rarr;</a>'; }
    function thumbs(list) { var h = ''; for (var i = 0; i < list.length; i++) h += '<img class="att" src="' + list[i] + '">'; return h; }
    function chips(list) { var c = $('rhaiChips'); c.innerHTML = ''; for (var i = 0; i < list.length; i++) { (function(t) { var b = document.createElement('button'); b.className = 'rhai-chip'; b.textContent = t; b.onclick = function() { $('rhaiText').value = t; send(); }; c.appendChild(b); })(list[i]); } }
    function log(m) { var a = dbGet('rh_activity'); a.push({ id: Date.now(), type: 'ai_assistant', message: m, date: new Date().toISOString() }); dbSet('rh_activity', a.slice(-100)); }
    function reset() { mem.flow = null; mem.title = ''; mem.images = []; $('rhaiAtt').classList.remove('has'); }
    function thinkDots(cb) {
        var d = document.createElement('div');
        d.className = 'rhai-msg bot';
        d.innerHTML = 'Thinking...';
        $('rhaiMsgs').appendChild(d);
        $('rhaiMsgs').scrollTop = $('rhaiMsgs').scrollHeight;
        setTimeout(function() { d.remove(); cb(); }, 600);
    }
    function makeProduct(title, cost, price, images) {
        var cats = dbGet('rh_categories');
        var ps = dbGet('rh_products');
        var np = { id: Date.now(), name: title, sku: 'AI-' + String(Date.now()).slice(-5), category: cats.length ? cats[0].name : 'General', section: '', subSection: '', description: '', cost: cost, price: price, stock: 100, deliveryDays: '2-3', weight: '', images: images || [], image: (images && images.length) ? images[0] : '', icon: 'fa-box', sizes: ['Free Size'], colors: [], versions: ['Standard'] };
        ps.push(np); dbSet('rh_products', ps);
        log('AI created product: ' + title + ' with ' + (images ? images.length : 0) + ' images');
        return np;
    }
    function getStats() {
        var o = dbGet('rh_orders'), r = dbGet('rh_resellers'), w = dbGet('rh_withdrawals');
        var po = 0, de = 0, sa = 0;
        for (var i = 0; i < o.length; i++) { if (o[i].status !== 'delivered' && o[i].status !== 'cancel' && o[i].status !== 'cancelled') po++; if (o[i].status === 'delivered') de++; sa += o[i].amount || 0; }
        var ac = 0, pa = 0, on = 0;
        for (var j = 0; j < r.length; j++) { if (r[j].status === 'approved') ac++; if (r[j].status === 'pending') pa++; if (r[j].lastSeen && Date.now() - new Date(r[j].lastSeen).getTime() < 300000) on++; }
        var pw = 0; for (var k = 0; k < w.length; k++) if (w[k].status === 'pending') pw++;
        return { o: o.length, po: po, de: de, p: dbGet('rh_products').length, r: r.length, ac: ac, pa: pa, on: on, sa: sa, pw: pw };
    }

    // ==================== BRAIN ====================
    function brain(raw) {
        var t = raw.toLowerCase().trim();
        function has() { for (var i = 0; i < arguments.length; i++) if (t.indexOf(arguments[i]) !== -1) return true; return false; }
        var s = getStats();

        // ---- MULTI-STEP FLOWS ----
        if (mem.flow === 'await_title') {
            if (t === 'cancel') { reset(); bot('OK, cancelled. Onno kichu lagbe?'); return; }
            mem.title = raw.trim();
            mem.flow = 'await_price';
            bot('Title: <b>' + mem.title + '</b> OK' + (mem.images.length ? ' + ' + mem.images.length + ' image ready' : '') + '\n\nEkhon dam likhun:\ncost 300 price 500\n(ekta number dile seta price hobe, cost auto 60%)\n\n"cancel" likhe bad dite paren.');
            chips(['cancel']);
            return;
        }
        if (mem.flow === 'await_price') {
            if (t === 'cancel') { reset(); bot('Cancelled.'); return; }
            var cm = raw.match(/cost\s*[:=]?\s*(\d+)/i), pm = raw.match(/price\s*[:=]?\s*(\d+)/i), nums = raw.match(/\d+/g);
            var cost, price;
            if (cm && pm) { cost = parseInt(cm[1]); price = parseInt(pm[1]); }
            else if (nums && nums.length >= 2) { cost = parseInt(nums[0]); price = parseInt(nums[1]); }
            else if (nums && nums.length === 1) { price = parseInt(nums[0]); cost = Math.round(price * 0.6); }
            else { bot('Bujhi nai! Evabe likhun: cost 300 price 500'); return; }
            thinkDots(function() {
                var np = makeProduct(mem.title, cost, price, mem.images.slice());
                var nimg = np.images.length;
                reset();
                bot('Product complete!<br> ' + np.name + '<br>Cost: ' + cost + ' TK | Price: ' + price + ' TK<br>Profit: ' + (price - cost) + ' TK/pc<br>Images: ' + nimg + ' ta' + (nimg ? ' - gallery te dekhabe' : '') + '<br><br>' + link('products.html', 'Dekhte jan'));
                chips(['add product', 'show stats']);
            });
            return;
        }
        if (mem.flow === 'await_category') {
            var c = dbGet('rh_categories');
            c.push({ id: Date.now(), name: raw.trim(), icon: 'fa-tag', count: 0, color: '#2563eb' });
            dbSet('rh_categories', c); log('AI created category: ' + raw.trim());
            mem.flow = null;
            bot('Category add holo: <b>' + raw.trim() + '</b> ' + link('settings.html', 'Dekhun'));
            return;
        }

        // ---- IMAGE + PRODUCT COMBO ----
        if (mem.images.length && has('add product', 'product add', 'product banao', 'upload', 'create product', 'ei image', 'ei chobi')) {
            mem.flow = 'await_title';
            bot('Image dekhlam, sundor!<br>' + thumbs(mem.images) + '\n\nEkhon product-er <b>title/nam</b> likhun, tarpor dam. Sob dile puro product baneye debo!');
            return;
        }
        if (mem.images.length && (mem.flow === 'await_title' || mem.flow === 'await_price')) {
            bot(mem.images.length + ' ta image product-er sathe jog holo:<br>' + thumbs(mem.images) + (mem.flow === 'await_title' ? '\n\nEkhon <b>title</b> likhun:' : '\n\nEkhon dam: cost X price Y'));
            return;
        }

        // ---- SMALL TALK ----
        if (/^(hi|hello|hey|salam|assalam|hii)/.test(t)) { bot(pick(['Assalamu alaikum! Aj ki korte chan? Apnar system-e ekhon ' + s.p + ' product, ' + s.o + ' order ache.', 'Hello boss! Bolen ki korbo?'])); chips(['show stats', 'add product', 'pending', 'help']); return; }
        if (has('kemon acho', 'how are you', 'kemoka')) { bot('Bhalo achi! Apnar business niye bhabte bhalobasi - ' + s.po + ' ta order cholche ekhon! Apnar kemon cholche?'); return; }
        if (has('thanks', 'thank', 'dhonnobad')) { bot(pick(['Swagatam! Aro kichu lagbe?', 'Always for you! Aro kichu?'])); return; }
        if (has('tumi ke', 'who are you', 'your name')) { bot('Ami <b>RH Smart Assistant</b> - apnar admin panel-er nijossho AI. Ami <b>chobi dekhte pari</b> (paperclip diye din), chinta korte pari, product banate pari, hishab rakhte pari, prosner uttor dite pari!'); return; }
        if (has('good job', 'nice', 'tumi paris', 'well done')) { bot('Dhonnobad! Cholon aro boro kichu kori - bolen ki korbo?'); return; }

        // ---- STATS ----
        if (has('stats', 'statistic', 'report', 'koyta', 'koto gulo', 'how many', 'situation')) {
            bot('<b>Live Report</b><br>Orders: <b>' + s.o + '</b> (running: ' + s.po + ', delivered: ' + s.de + ')<br>Products: <b>' + s.p + '</b><br>Resellers: <b>' + s.r + '</b> (active ' + s.ac + ', pending ' + s.pa + ')<br>Online: <b>' + s.on + '</b><br>Sales: <b>' + s.sa + ' TK</b><br>Pending Withdraw: <b>' + s.pw + '</b><br>' + link('dashboard.html', 'Dashboard'));
            return;
        }
        if (has('pending')) { bot(s.pa ? s.pa + ' ta reseller approval baki! ' + link('approvals.html', 'Approve korun') : (s.pw ? s.pw + ' ta withdrawal pending. ' + link('withdrawals.html', 'Dekhun') : 'Kichui pending nai, sob clear!')); return; }
        if (has('online')) { bot('Ekhon <b>' + s.on + '</b> jon online. ' + link('resellers.html', 'Ke ke?')); return; }
        if (has('top', 'best', 'sera')) {
            var rs = dbGet('rh_resellers').sort(function(a, b) { return (b.totalEarning || 0) - (a.totalEarning || 0); }).slice(0, 3);
            var out = '<b>Top Resellers</b><br>';
            for (var i = 0; i < rs.length; i++) out += (i + 1) + '. ' + rs[i].name + ' - ' + (rs[i].totalEarning || 0) + ' TK<br>';
            bot(out); return;
        }

        // ---- ADD PRODUCT ----
        var one = raw.match(/add product\s+(.+?)\s+(?:price|dam)\s*(\d+)/i);
        if (one) {
            var pr = parseInt(one[2]); var co = raw.match(/cost\s*(\d+)/i);
            var cc = co ? parseInt(co[1]) : Math.round(pr * 0.6);
            thinkDots(function() {
                var np = makeProduct(one[1], cc, pr, mem.images.slice()); reset();
                bot('Hoilo!<br> ' + np.name + ' | ' + cc + ' > ' + pr + ' TK<br>Images: ' + np.images.length + '<br>' + link('products.html', 'Dekhun'));
            });
            return;
        }
        if (has('add product', 'product add', 'product banao', 'notun product', 'product upload')) {
            mem.flow = 'await_title';
            bot('Shuru kori! ' + (mem.images.length ? mem.images.length + ' ta image ready ache' : 'chaille paperclip diye image din (na-o dile paren)') + '\n\nProduct-er <b>title/nam</b> likhun:');
            chips(['cancel']);
            return;
        }
        if (has('add category', 'category add')) {
            var cx = raw.match(/category\s+(?:add\s+)?(.+)/i);
            if (cx && cx[1].length > 2 && !/kivabe|how/.test(cx[1])) { var c2 = dbGet('rh_categories'); c2.push({ id: Date.now(), name: cx[1].trim(), icon: 'fa-tag', count: 0, color: '#2563eb' }); dbSet('rh_categories', c2); log('AI category: ' + cx[1]); bot('Category: <b>' + cx[1] + '</b> add holo!'); }
            else { mem.flow = 'await_category'; bot('Category-r nam likhun:'); }
            return;
        }

        // ---- NAVIGATION ----
        if (has('order') && has('show', 'open', 'dekh', 'go')) { nav('orders.html'); return; }
        if (has('product') && has('show', 'open', 'dekh', 'go') && !has('add')) { nav('products.html'); return; }
        if (has('reseller') && has('show', 'open', 'dekh', 'go', 'list')) { nav('resellers.html'); return; }
        if (has('withdraw')) { nav('withdrawals.html'); return; }
        if (has('approv')) { nav('approvals.html'); return; }
        if (has('setting')) { nav('settings.html'); return; }
        if (has('dashboard', 'home page')) { nav('dashboard.html'); return; }

        // ---- HELP ----
        if (has('help', 'what can', 'kaj', 'ki pari')) { help(); return; }

        // ---- SMART FALLBACK ----
        bot(pick([
            'Hmm... eta niye amar special knowledge kom, tobe apnar <b>business</b> niye ja jani bolte pari! Ekhon ' + s.p + ' product, ' + s.o + ' order, ' + s.r + ' reseller ache. Egulo niye jante chan? Naki kichu <b>kore dite</b> chan?',
            'Hum, e niye confident na. Tobe egulote master: <b>product banano (image soho!)</b>, order/reseller dekha, stats. "help" likhun sob dekhte!'
        ]));
        chips(['show stats', 'add product', 'help']);
    }

    function help() {
        bot('<b>Amar sob power:</b><br><br><b>Image dekhte pari!</b> Paperclip chapun > chobi din > "add product" likhun > title + dam dile chobisoh product ready!<br><br><b>add product</b> - full flow<br><b>stats / report</b> - sob hishab<br><b>show orders / resellers</b><br><b>pending / online / top resellers</b><br><b>add category [name]</b><br><br>Aro sadaron kothao o chalano jay!');
        chips(['show stats', 'add product', 'pending', 'top resellers']);
    }
    function nav(p) { bot('Khulche...'); setTimeout(function() { window.location.href = p; }, 500); }

    function send() {
        var inp = $('rhaiText');
        var v = inp.value.trim();
        if (!v && !mem.images.length) return;
        if (v) addMsg(v, 'user');
        if (v && mem.images.length && mem.flow !== 'await_title' && mem.flow !== 'await_price') addMsg(thumbs(mem.images), 'user');
        inp.value = '';
        var cmd = v || (mem.images.length ? 'add product' : '');
        thinkDots(function() { brain(cmd); });
    }

    $('rhaiBtn').onclick = function() {
        $('rhaiPanel').classList.add('open'); $('rhaiBtn').style.display = 'none';
        if (!$('rhaiMsgs').children.length) bot('Assalamu alaikum! Ami <b>RH Smart Assistant</b> - ami chinta korte pari, <b>chobi dekhte pari</b> (paperclip), ar apnar admin kaj kore dite pari!<br><br>Bolen ki korbo?');
        $('rhaiText').focus();
    };
    $('rhaiCls').onclick = function() { $('rhaiPanel').classList.remove('open'); $('rhaiBtn').style.display = 'block'; };
    $('rhaiSend').onclick = send;
    $('rhaiText').addEventListener('keydown', function(e) { if (e.key === 'Enter') send(); });
    $('rhaiAtt').onclick = function() { $('rhaiFile').click(); };
    $('rhaiFile').addEventListener('change', function(e) {
        var files = e.target.files; if (!files.length) return;
        var pending = 0;
        for (var i = 0; i < files.length; i++) {
            if (files[i].size > 2 * 1024 * 1024) { bot('Ekta chobi boro hoye geche (Max 2MB)'); continue; }
            (function(f) {
                var r = new FileReader();
                r.onload = function() {
                    mem.images.push(r.result); pending--;
                    if (pending === 0) {
                        $('rhaiAtt').classList.add('has');
                        bot('<b>' + mem.images.length + ' ta chobi dekhte pachhi!</b><br>' + thumbs(mem.images) + '\n\nEkhon <b>add product</b> likhun (ba directly title din) - chobisoh product baneye debo!');
                    }
                };
                r.readAsDataURL(f);
            })(files[i]);
        }
        e.target.value = '';
    });
})();
