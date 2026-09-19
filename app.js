// ResellerHub BD - Complete Data Layer v3.0
// Stylex Shopping is the PERMANENT owner account

/* ==========================================================================
   SHARED STORE SYNC  (2026-09-16)
   --------------------------------------------------------------------------
   WHY. Everything below reads and writes localStorage. localStorage is per
   BROWSER: a customer who registers on their phone writes to THEIR phone, and
   the admin on a laptop can never see it. Two devices could never share one
   dataset — which made the app impossible to test and impossible to run as a
   real multi-user site.

   server.js now exposes a small shared store (/api/store). This block keeps
   localStorage and that store in step:

     1. BOOT — one SYNCHRONOUS read of the store, written into localStorage
        before any page code runs, so every page renders the shared data on its
        very first paint. No async, no flash of empty content.
     2. WRITE — setData() pushes the key it just saved (debounced per key).
     3. WATCH — a light poll pulls anything another device changed.

   WHEN THERE IS NO SERVER (opened as a file:// page, or a static-only host) the
   synchronous read simply fails and everything behaves exactly as before —
   localStorage only. Nothing here can break a page.
   ========================================================================== */
var RH_STORE_ON = false;          /* true once we know the shared store answers */

(function rhStoreBoot() {
    try {
        if (location.protocol === 'file:') return;
        var x = new XMLHttpRequest();
        /* 2026-09-17 — SPEED: ask for everything EXCEPT the image bytes. The images
           are fetched separately below (asynchronously), so the blocking boot payload
           is a few KB instead of several MB. */
        x.open('GET', '/api/store?noimg=1', false);   /* synchronous: must finish before the app reads */
        x.send(null);
        if (x.status !== 200) return;
        var j = JSON.parse(x.responseText || '{}');
        if (!j || !j.ok || !j.data) return;
        var n = 0, imgs = {};
        for (var k in j.data) {
            if (!Object.prototype.hasOwnProperty.call(j.data, k)) continue;
            if (String(k).indexOf('rh_') !== 0) continue;
            /* 2026-09-17 — IMAGE BYTES must NOT go into localStorage: they are large
               and would blow the quota, and they belong in IndexedDB where the image
               layer already reads from. Collect them and hand them over below. */
            if (String(k).indexOf('rh_img_') === 0) { imgs[k] = j.data[k]; continue; }
            try { localStorage.setItem(k, JSON.stringify(j.data[k])); n++; } catch (e) { }
        }
        RH_STORE_ON = true;
        /* Now put every shared image into IndexedDB, then fix the <img> tags that are
           still showing a placeholder because the bytes were missing. This is what
           makes an image uploaded on one device appear on every other device. */
        try {
            var _pk = [];
            for (var ik in imgs) {
                if (!Object.prototype.hasOwnProperty.call(imgs, ik)) continue;
                _pk.push([String(ik).slice('rh_img_'.length), imgs[ik]]);
            }
            if (_pk.length && typeof rhImgPutAll === 'function') {
                rhImgPutAll(_pk, function () { });
                setTimeout(function () { try { if (typeof rhResolveImgTags === 'function') rhResolveImgTags(); } catch (e) { } }, 400);
            }
        } catch (e) { }
        window.__rhStoreKeys = n;
    } catch (e) { /* no server — localStorage only, exactly as before */ }
})();

var _rhPushTimers = {};
/* Push one key to the shared store. Debounced, because setData() is called often
   and some payloads (base64 images) are large. */
/* storewatch-pending (2026-09-17, this request).
   rhStoreWatch() polls the server and copies any key that differs back into
   localStorage. But rhStorePush() is DEBOUNCED by 400ms, so for a moment after a
   local save the server still holds the OLD value — and the poll copied that stale
   value straight back over the user's change. A deleted section reappeared and the
   delete looked like it had "reset itself".
   This map records when each key was last written locally; the watcher leaves any
   key alone while its push is still in flight or its local write is very recent. */
var _rhLocalWriteAt = {};
function rhStoreMarkLocal(key) { try { _rhLocalWriteAt[key] = Date.now(); } catch (e) { } }
function rhStoreLocalBusy(key) {
    try {
        if (_rhPushTimers[key]) return true;                       /* push still queued */
        var t = _rhLocalWriteAt[key];
        return !!(t && (Date.now() - t) < 3000);                   /* written seconds ago */
    } catch (e) { return false; }
}
function rhStorePush(key) {
    /* mark BEFORE the store check — the protection must work even when there is no
       server (RH_STORE_ON false), otherwise a page with no server would still let a
       poll overwrite a fresh local write. */
    rhStoreMarkLocal(key);                       /* mark BEFORE the store check */
    if (!RH_STORE_ON) return;
    try {
        if (_rhPushTimers[key]) clearTimeout(_rhPushTimers[key]);
        _rhPushTimers[key] = setTimeout(function () {
            _rhPushTimers[key] = null;
            try {
                var raw = localStorage.getItem(key);
                var val = raw === null ? null : JSON.parse(raw);
                fetch('/api/store', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: key, value: val })
                }).catch(function () { });
            } catch (e) { }
        }, 400);
    } catch (e) { }
}
/* 2026-09-19 — POLL COST (option 1: the three small, low-risk changes).
   1. 15s -> 60s. Every open tab used to ask the server four times a minute;
      with a thousand resellers online that is most of the load on its own.
   2. `cache: 'no-store'` forced a FULL re-download on every single poll. The
      server already sends an ETag plus `Cache-Control: no-cache`, so switching
      to 'no-cache' makes the browser revalidate: when nothing changed the
      server answers 304 with NO body. Data can still never go stale — 'no-cache'
      means "you may keep it, but you MUST ask every time".
   3. A tab the user is not looking at no longer reloads. It still merges the
      new data, and reloads the moment the tab becomes visible again.
   Nothing else changes: a change made on another device STILL shows up on its
   own, and F5 / the browser refresh button are untouched — this only governs
   the automatic background refresh.
   RH_WATCH_MS is left as a variable so the interval can be tuned (or put back
   to 15000) without editing this function again. */
var RH_WATCH_MS = 60000;
/* Pull the store and reload only when something actually changed, so a second
   device's registration appears here without the user touching anything. */
function rhStoreWatch() {
    if (!RH_STORE_ON) return;
    var last = null;
    var pendingReload = false;
    function rhTypingNow() {
        try {
            var ae = document.activeElement;
            if (!ae) return false;
            var t = String(ae.tagName || '').toUpperCase();
            if (t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') return false;
            return String(ae.value || '').length > 0;
        } catch (e) { return false; }
    }
    setInterval(function () {
        try {
            /* 2026-09-17 — do NOT reload while the user is typing. The poll used to
               reload the page the moment the store changed, which wiped a half-typed
               email or password (and looked like a random refresh). The data is still
               merged below; only the re-render is held back until the field is idle. */
            /* 2026-09-19 — a tab nobody is looking at must not spend a reload. */
            if (pendingReload && !rhTypingNow() && !document.hidden) { location.reload(); return; }
            fetch('/api/store?noimg=1', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (j) {
                if (!j || !j.ok || !j.data) return;
                var sig = JSON.stringify(j.data);
                if (last === null) { last = sig; return; }     /* first read = baseline */
                if (sig === last) return;                      /* nothing changed */
                last = sig;
                var changed = false;
                for (var k in j.data) {
                    if (!Object.prototype.hasOwnProperty.call(j.data, k)) continue;
                    if (String(k).indexOf('rh_') !== 0) continue;
                    /* never overwrite a key the user just changed locally — its push
                       has not reached the server yet, so the server value is STALE. */
                    if (rhStoreLocalBusy(k)) continue;
                    var now = JSON.stringify(j.data[k]);
                    var mine = localStorage.getItem(k);
                    if (now !== mine) {
                        try { localStorage.setItem(k, now); changed = true; } catch (e) { }
                    }
                }
                if (!changed) return;
                if (rhTypingNow()) { pendingReload = true; return; }   /* hold the reload, retry later */
                /* 2026-09-19 — hold it while the tab is in the background too. The
                   data above is already merged, so the reload only has to repaint —
                   and a background tab repainting is pure waste. */
                if (document.hidden) { pendingReload = true; return; }
                location.reload();
            }).catch(function () { });
        } catch (e) { }
    }, RH_WATCH_MS);
    /* 2026-09-19 — come back to the tab and the held-back reload happens at once,
       instead of waiting for the next poll tick. */
    try {
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && pendingReload && !rhTypingNow()) {
                pendingReload = false;
                try { location.reload(); } catch (e) { }
            }
        });
    } catch (e) { }
}
/* start the watcher once the page has settled, so it never competes with the
   first paint. It no-ops entirely when there is no shared store. */
try { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rhStoreWatch); else setTimeout(rhStoreWatch, 0); } catch (e) { }

var DB_KEYS = {
    PRODUCTS: 'rh_products',
    ORDERS: 'rh_orders',
    RESELLERS: 'rh_resellers',
    WITHDRAWALS: 'rh_withdrawals',
    TRANSACTIONS: 'rh_transactions',
    CATEGORIES: 'rh_categories',
    NOTIFICATIONS: 'rh_notIFICATIONS',
    SETTINGS: 'rh_settings',
    SUPPORT: 'rh_support',
    BANNERS: 'rh_banners',
    COUPONS: 'rh_coupons',
    TRACKING: 'rh_tracking',
    ACTIVITY: 'rh_activity',
    SIZES: 'rh_sizes',
    COLORS: 'rh_colors',
    SECTIONS: 'rh_sections',
    SUB_SECTIONS: 'rh_sub_sections',
    VERSIONS: 'rh_versions',
    ONLINE: 'rh_online',
    SUPPLIERS: 'rh_suppliers',
    REVIEWS: 'rh_reviews',
    /* Referral system — RESELLER (#45) */
    REFERRAL_RELATIONS: 'rh_referral_relations',
    REFERRAL_COMMISSIONS: 'rh_referral_commissions',
    /* Referral system — SUPPLIER (kept in separate stores so reseller and
       supplier referral data are always separately identifiable) */
    SUPPLIER_REFERRAL_RELATIONS: 'rh_supplier_referral_relations',
    SUPPLIER_REFERRAL_COMMISSIONS: 'rh_supplier_referral_commissions',
    /* My Shop — per-reseller storefront (keyed by reseller id) */
    SHOP_SETTINGS: 'rh_shop_settings',
    /* ITEM 20 — the hand-arranged homepage sections of a My Shop (keyed by
       reseller id): { "<rid>": { "<cat||sub||subsub>": ["pid", …] } } */
    SHOP_SECTIONS: 'rh_shop_sections',
    SHOP_CATEGORIES: 'rh_shop_categories',
    /* My Shop CUSTOMER accounts — keyed by reseller id, so a customer always
       belongs to exactly ONE shop (see the shop customer module below) */
    SHOP_CUSTOMERS: 'rh_shop_customers',
    /* My Shop CUSTOMER <-> RESELLER chats — keyed by reseller id first, so a
       conversation can only ever be reached through its own shop. */
    SHOP_CHATS: 'rh_shop_chats',
    /* Offers + Banners — one shared offer definition, per-reseller state */
    OFFERS: 'rh_offers',
    OFFER_STATE: 'rh_offer_state',
    /* Reseller-owned My Shop categories (keyed by reseller id) */
    SHOP_OWN_CATEGORIES: 'rh_shop_own_categories',
    /* Direct messages: reseller/supplier <-> admin */
    MESSAGES: 'rh_messages',
    /* Per-reseller Street First (Steadfast) accounts.
       Shape: { [resellerId]: { apiKey, secret, savedAt, testedAt, connected } }
       Values are stored OBFUSCATED (never plaintext) and are only ever read by
       the shipment layer below — no page renders them. When a backend proxy is
       configured the keys live server-side instead (see backend/steadfast-proxy.php). */
    SF_ACCOUNTS: 'rh_sf_accounts',
    /* 2026-09-19 — per-reseller accounts with ANY courier (this request).
       Shape: { [resellerId]: { [courierId]: { apiKey, secret, base, auth,
                                                label, savedAt, testedAt,
                                                connected, serverSaved } } }
       Same obfuscation-at-rest as SF_ACCOUNTS, and the same rule: only the
       MASKED view ever reaches a page. Steadfast is mirrored into SF_ACCOUNTS
       as well, so the proven sf* shipment path keeps working untouched. */
    COURIER_ACCOUNTS: 'rh_courier_accounts',
    /* Which courier this reseller books to by default. Shape: { [rid]: courierId } */
    COURIER_ACTIVE: 'rh_courier_active',
    /* Moderators — restricted admin accounts created by the real admin.
       Shape: { id, name, email, password, phone, active, createdAt } */
    MODERATORS: 'rh_moderators',
    /* Balance changes a moderator asked for, waiting on the real admin.
       Shape: { id, kind, party, partyId, partyName, sign, amount, note,
                status, requestedBy, requestedByName, date, handledAt } */
    MOD_REQUESTS: 'rh_mod_requests',
    /* 2026-09-18 — the ADMIN's default look for every reseller's My Shop:
       { bannerImages: [up to 3], blocks: [homepage blocks] }.
       Kept in its OWN key on purpose: site settings are saved as a whole object
       by the admin Settings page, so parking these inside `rh_settings` would let
       an unrelated save wipe them. Nothing here is per-reseller — every shop
       falls back to this same record until the reseller overrides it. */
    MYSHOP_DEFAULTS: 'rh_myshop_defaults',
    /* 2026-09-18 — CUSTOMER INFORMATION: a per-reseller address book filled in
       automatically from My Shop register/login/order/chat and from the reseller
       placing an order in the panel.
       Shape: { "<rid>": [ { id, name, phone, address, source, createdAt, updatedAt } ] }
       Keyed by reseller id FIRST, exactly like rh_shop_customers, so one shop's
       customer can never appear in another's list. */
    CUSTOMER_INFO: 'rh_customer_info'
};

/* ===== Referral configuration (#25, #26, #46) ===== */
var REFERRAL_CFG = {
    TIER1_RATE: 5,            // ৳5 per delivered order
    TIER2_RATE: 10,           // ৳10 per delivered order
    TIER2_MIN_REFERRALS: 50,  // need 50 QUALIFIED referred resellers
    TIER2_MIN_DELIVERED: 5    // a referred reseller qualifies at >= 5 delivered orders
};

/* Supplier referral uses the same commercial rules but lives in its own
   config object so the two programmes can be tuned independently. */
var SUPPLIER_REFERRAL_CFG = {
    TIER1_RATE: 5,            // ৳5 per delivered order
    TIER2_RATE: 10,           // ৳10 per delivered order
    TIER2_MIN_REFERRALS: 50,  // >= 50 QUALIFIED referred suppliers
    TIER2_MIN_DELIVERED: 5    // a referred supplier qualifies at >= 5 delivered orders
};

var SITE_INFO = {
    siteName: "ResellerHub BD",
    sitePhone: "01997904792",
    siteEmail: "stylexshopping@gmail.com",
    siteWebsite: "resellerhubbd.com/",
    siteAddress: "Dhaka, Bangladesh",
    facebook: "https://www.facebook.com/",
    youtube: "#",
    instagram: "#"
};

// PERMANENT OWNER ACCOUNT - cannot be deleted
/* 2026-09-19 — THE FINANCIAL FIGURES START AT ZERO.
   This account used to be seeded with balance 15000, totalOrders 5,
   totalWithdraw 3000 and totalEarning 8500. Those were DEMO numbers from the
   prototype, and this is a real account on a live site: it made the owner's own
   panel claim ৳15,000 and five orders that never happened, and any report built
   on it was wrong from the first load. A real account must start empty and be
   filled in by real trading. */
var STYLEX_ACCOUNT = {
    id: 1,
    name: "Stylex Shopping",
    phone: "01997904792",
    email: "stylexshopping@gmail.com",
    password: "Stylexshopping@26",
    balance: 0,
    totalOrders: 0,
    totalWithdraw: 0,
    totalEarning: 0,
    joinDate: "2024-01-01",
    status: "approved",
    approvalDate: "2024-01-01",
    address: "House 12, Road 5, Dhanmondi, Dhaka",
    nid: "1990123456",
    nidFrontImage: "",
    nidBackImage: "",
    businessName: "Stylex Shopping",
    facebookUrl: "https://facebook.com/stylexshopping",
    websiteUrl: "https://stylexshopping.com",
    referralCode: "STYLEX01",
    referredBy: null,
    isPermanent: true,
    role: "owner",
    profilePicture: "",
    lastSeen: new Date().toISOString(),
    isOnline: true
};

function genProductImage(name, icon, color) {
    color = color || '#2563eb';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">' +
        '<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">' +
        '<stop offset="0%" style="stop-color:' + color + ';stop-opacity:0.15"/>' +
        '<stop offset="100%" style="stop-color:' + color + ';stop-opacity:0.4"/></linearGradient></defs>' +
        '<rect fill="url(#g)" width="300" height="300"/>' +
        '<circle cx="150" cy="150" r="90" fill="white" opacity="0.95"/>' +
        '<text x="150" y="175" font-size="80" text-anchor="middle" font-family="Arial" fill="' + color + '">\uD83D\uDED2</text>' +
        '</svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

var DEFAULT_SIZES = ["S", "M", "L", "XL", "XXL", "Free Size"];
var DEFAULT_COLORS = ["Red", "Blue", "Green", "Black", "White", "Yellow", "Pink", "Gray", "Multi Color"];
// Sections & Sub-Sections now support emoji + image (admin can manage them)
var DEFAULT_SECTIONS = [
    { id: 1, name: "Men's", emoji: "👨", image: "" },
    { id: 2, name: "Women's", emoji: "👩", image: "" },
    { id: 3, name: "Kids", emoji: "🧒", image: "" },
    { id: 4, name: "Unisex", emoji: "👥", image: "" },
    { id: 5, name: "Elderly", emoji: "🧓", image: "" }
];
var DEFAULT_SUB_SECTIONS = [
    { id: 1, name: "Top Wear", emoji: "👕", image: "" },
    { id: 2, name: "Bottom Wear", emoji: "👖", image: "" },
    { id: 3, name: "Footwear", emoji: "👟", image: "" },
    { id: 4, name: "Accessories", emoji: "🧢", image: "" },
    { id: 5, name: "Electronics", emoji: "📱", image: "" },
    { id: 6, name: "Beauty", emoji: "💄", image: "" },
    { id: 7, name: "Home Decor", emoji: "🛋️", image: "" },
    { id: 8, name: "Sports Wear", emoji: "⚽", image: "" },
    { id: 9, name: "Casual", emoji: "🎨", image: "" },
    { id: 10, name: "Formal", emoji: "🤵", image: "" }
];
var DEFAULT_VERSIONS = ["Standard", "Premium", "Deluxe", "Limited Edition", "New Arrival"];

// Normalize helpers - work with both old string arrays and new objects
function getSectionsList() {
    var arr = getData(DB_KEYS.SECTIONS);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        if (typeof s === 'string') out.push({ name: s, emoji: '', image: '' });
        else out.push({ id: s.id, name: s.name, emoji: s.emoji || '', image: s.image || '' });
    }
    return out;
}
function getSubSectionsList() {
    var arr = getData(DB_KEYS.SUB_SECTIONS);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        if (typeof s === 'string') out.push({ name: s, emoji: '', image: '' });
        else out.push({ id: s.id, name: s.name, emoji: s.emoji || '', image: s.image || '' });
    }
    return out;
}
// Find a section object by name (for emoji display)
function findSection(name) {
    var list = getSectionsList();
    for (var i = 0; i < list.length; i++) { if (list[i].name === name) return list[i]; }
    return null;
}
function findSubSection(name) {
    var list = getSubSectionsList();
    for (var i = 0; i < list.length; i++) { if (list[i].name === name) return list[i]; }
    return null;
}
// Display: emoji/image + name
function sectionDisplay(name) {
    var s = findSection(name);
    if (!s) return name || '-';
    if (s.image) return '<img src="' + s.image + '" style="width:16px;height:16px;border-radius:4px;object-fit:cover;vertical-align:middle;margin-right:4px;">' + s.name;
    if (s.emoji) return s.emoji + ' ' + s.name;
    return s.name;
}
function subSectionDisplay(name) {
    var s = findSubSection(name);
    if (!s) return name || '-';
    if (s.image) return '<img src="' + s.image + '" style="width:16px;height:16px;border-radius:4px;object-fit:cover;vertical-align:middle;margin-right:4px;">' + s.name;
    if (s.emoji) return s.emoji + ' ' + s.name;
    return s.name;
}

/* ---------------------------------------------------------------------------
   MAIN CATEGORY TREE (items 17-22)
   Exactly SIX primary categories, each with its subcategories and sub-subcategories.
   This array is the SEED only — the live tree is always read from
   DB_KEYS.CATEGORIES, so the admin can add / edit / disable at all three levels
   and the change lands in the database, not in this file.
   Shape:  { id, name, icon, color, subs: [ { name, subSubs: [ '…' ] } ] }
   --------------------------------------------------------------------------- */
var MAIN_CATEGORY_NAMES = [
    "Men's Fashion",
    'Men Fashion',
    "Women's Fashion",
    'Women Fashion',
    'Women Lifestyle',
    'Gadget & Electronics',
    'Special Product',
    'Foods & Kids'
];
var MAIN_CATEGORY_TREE = [
    {
        id: 'MC1', name: 'Men Fashion', icon: 'fa-shirt', color: '#2563eb',
        subs: [
            { name: 'Shirt', subSubs: ['Casual Shirt', 'Formal Shirt', 'Party Shirt', 'Check Shirt', 'Plain Shirt'] },
            { name: 'T-Shirt', subSubs: ['Half Sleeve', 'Full Sleeve', 'Polo T-Shirt', 'Drop Shoulder', 'Oversize T-Shirt'] },
            { name: 'Pant', subSubs: ['Formal Pant', 'Casual Pant', 'Chino Pant', 'Jeans Pant', 'Cargo Pant'] },
            { name: 'Panjabi', subSubs: ['Casual Panjabi', 'Formal Panjabi', 'Eid Panjabi', 'Embroidered Panjabi'] },
            { name: 'Kabli / Kurta', subSubs: ['Kabli', 'Kurta', 'Kurta Pajama', 'Slim Fit Kabli'] },
            { name: 'Jacket', subSubs: ['Denim Jacket', 'Leather Jacket', 'Winter Jacket', 'Puffer Jacket', 'Hoodie Jacket'] },
            { name: 'Hoodie & Sweater', subSubs: ['Hoodie', 'Sweater', 'Half Zip Sweater', 'Cardigan'] },
            { name: 'Denim Item', subSubs: ['Denim Shirt', 'Denim Pant', 'Denim Jacket'] },
            { name: 'Suit & Blazer', subSubs: ['Two Piece Suit', 'Three Piece Suit', 'Blazer', 'Waist Coat'] },
            { name: 'Underwear', subSubs: ['Boxer', 'Brief', 'Undershirt', 'Vest'] },
            { name: 'Accessories', subSubs: ['Belt', 'Wallet', 'Cap', 'Tie', 'Sunglass', 'Watch', 'Socks'] },
            { name: 'Shoes & Sandal', subSubs: ['Formal Shoes', 'Casual Shoes', 'Sneakers', 'Loafer', 'Sandal', 'Slipper'] },
            { name: 'Slipper', subSubs: ['Rubber Slipper', 'Fancy Slipper', 'Home Slipper'] },
            { name: 'Track Suit', subSubs: ['Winter Track Suit', 'Summer Track Suit', 'Sports Track Suit'] },
            { name: 'Sports Wear', subSubs: ['Sports Jersey', 'Sports Pant', 'Sports Set'] },
            { name: 'Combo Offer', subSubs: ['Shirt + Pant Combo', 'T-Shirt Combo Pack', 'Panjabi Combo', 'Family Combo'] },
            { name: 'Winter Collection', subSubs: ['Winter Jacket', 'Sweater', 'Hoodie', 'Muffler', 'Beanie'] },
            { name: 'Gift Item', subSubs: ['Gift for Him', 'Gift Combo', 'Gift Box'] }
        ]
    },
    {
        id: 'MC2', name: 'Women Fashion', icon: 'fa-person-dress', color: '#ec4899',
        subs: [
            { name: 'Saree', subSubs: ['Cotton Saree', 'Silk Saree', 'Jamdani Saree', 'Katan Saree', 'Half Silk Saree', 'Party Saree'] },
            { name: 'Three Piece', subSubs: ['Cotton Three Piece', 'Silk Three Piece', 'Party Three Piece', 'Half Silk Three Piece', 'Unstitched Three Piece'] },
            { name: 'Salwar Kameez', subSubs: ['Cotton Salwar Kameez', 'Party Salwar Kameez', 'Printed Salwar Kameez'] },
            { name: 'Kurti', subSubs: ['Short Kurti', 'Long Kurti', 'Party Kurti', 'Printed Kurti', 'Embroidered Kurti'] },
            { name: 'Shirt & Top', subSubs: ['Casual Top', 'Formal Shirt', 'Party Top', 'Crop Top'] },
            { name: 'T-Shirt', subSubs: ['Half Sleeve', 'Full Sleeve', 'Oversize T-Shirt', 'Printed T-Shirt'] },
            { name: 'Pant & Jeans', subSubs: ['Jeans Pant', 'Casual Pant', 'Formal Pant', 'Palazzo', 'Cargo Pant'] },
            { name: 'Skirt & Plazo', subSubs: ['Long Skirt', 'Short Skirt', 'Plazo', 'Skirt Top Set'] },
            { name: 'Borka, Abaya & Hijab', subSubs: ['Borka', 'Abaya', 'Hijab', 'Naqab', 'Burkha Set'] },
            { name: 'Nightwear', subSubs: ['Night Dress', 'Pajama Set', 'Sleepwear', 'Night Gown'] },
            { name: 'Innerwear', subSubs: ['Bra', 'Panties', 'Camisole', 'Shapewear'] },
            { name: 'Shoes & Sandal', subSubs: ['Heels', 'Flat Shoes', 'Sneakers', 'Sandal', 'Slipper'] },
            { name: 'Bag & Purse', subSubs: ['Hand Bag', 'Shoulder Bag', 'Clutch', 'Wallet', 'Backpack'] },
            { name: 'Jewellery', subSubs: ['Necklace', 'Earring', 'Bangle', 'Ring', 'Bridal Set'] },
            { name: 'Cosmetics', subSubs: ['Makeup', 'Skin Care', 'Hair Care', 'Perfume'] },
            { name: 'Shawl & Scarf', subSubs: ['Shawl', 'Scarf', 'Stole', 'Winter Shawl'] },
            { name: 'Winter Collection', subSubs: ['Winter Jacket', 'Sweater', 'Hoodie', 'Shawl'] },
            { name: 'Combo Offer', subSubs: ['Three Piece Combo', 'Kurti Combo', 'Family Combo'] },
            { name: 'Gift Item', subSubs: ['Gift for Her', 'Gift Combo', 'Gift Box'] }
        ]
    },
    {
        id: 'MC3', name: 'Women Lifestyle', icon: 'fa-spa', color: '#d946ef',
        subs: [
            { name: 'Skin Care', subSubs: ['Face Wash', 'Toner', 'Moisturizer', 'Serum', 'Sunscreen', 'Face Pack'] },
            { name: 'Makeup', subSubs: ['Foundation', 'Compact Powder', 'Lipstick', 'Eyeliner', 'Mascara', 'Eyebrow Pencil', 'Blush'] },
            { name: 'Hair Care', subSubs: ['Shampoo', 'Conditioner', 'Hair Oil', 'Hair Serum', 'Hair Mask'] },
            { name: 'Beauty Tools', subSubs: ['Makeup Brush', 'Beauty Blender', 'Hair Straightener', 'Hair Dryer', 'Curler'] },
            { name: 'Perfume & Attar', subSubs: ['Body Spray', 'Perfume', 'Attar', 'Deodorant'] },
            { name: 'Fashion Accessories', subSubs: ['Hair Clip', 'Hair Band', 'Bindi', 'Nose Pin', 'Anklet'] },
            { name: 'Sanitary & Hygiene', subSubs: ['Sanitary Pad', 'Intimate Wash', 'Wet Tissue', 'Hand Sanitizer'] },
            { name: 'Personal Care', subSubs: ['Hand Cream', 'Foot Care', 'Body Lotion', 'Lip Balm'] },
            { name: 'Health & Wellness', subSubs: ['Vitamin', 'Herbal Product', 'Massager', 'Health Supplement'] },
            { name: 'Kitchen & Home', subSubs: ['Kitchen Tool', 'Home Decor', 'Storage Box', 'Bed Sheet'] },
            { name: 'Combo Package', subSubs: ['Skin Care Combo', 'Makeup Combo', 'Beauty Box'] },
            { name: 'Gift Item', subSubs: ['Beauty Gift Set', 'Gift for Her', 'Gift Box'] }
        ]
    },
    {
        id: 'MC4', name: 'Gadget & Electronics', icon: 'fa-mobile-screen', color: '#8b5cf6',
        subs: [
            { name: 'Mobile Phone', subSubs: ['Smartphone', 'Feature Phone', 'Android Phone', 'iPhone'] },
            { name: 'Mobile Accessories', subSubs: ['Back Cover', 'Tempered Glass', 'Charger', 'Data Cable', 'Power Bank', 'Phone Holder'] },
            { name: 'Earbuds & Headphone', subSubs: ['TWS Earbuds', 'Wired Earphone', 'Bluetooth Headphone', 'Gaming Headphone'] },
            { name: 'Speaker', subSubs: ['Bluetooth Speaker', 'Soundbar', 'Home Theater', 'Party Speaker'] },
            { name: 'Smart Watch', subSubs: ['Smart Watch', 'Fitness Band', 'Watch Strap', 'Smart Watch Combo'] },
            { name: 'Computer & Laptop', subSubs: ['Laptop', 'Desktop PC', 'Monitor', 'Keyboard', 'Mouse', 'Laptop Bag'] },
            { name: 'Computer Accessories', subSubs: ['Pen Drive', 'Hard Disk', 'SSD', 'RAM', 'Router', 'Webcam'] },
            { name: 'TV & Home Appliance', subSubs: ['LED TV', 'Android TV', 'Fan', 'Rice Cooker', 'Blender', 'Iron'] },
            { name: 'Light & Lamp', subSubs: ['LED Light', 'Emergency Light', 'Table Lamp', 'Decorative Light'] },
            { name: 'Camera & Photography', subSubs: ['Camera', 'Tripod', 'Ring Light', 'Camera Bag'] },
            { name: 'Gaming', subSubs: ['Game Pad', 'Gaming Mouse', 'Gaming Keyboard', 'Gaming Chair'] },
            { name: 'Home Electronics', subSubs: ['Voltage Stabilizer', 'IPS', 'Solar Panel', 'Water Purifier'] },
            { name: 'Electrical Item', subSubs: ['Extension Board', 'Switch Socket', 'Wire Cable', 'Circuit Breaker'] },
            { name: 'Combo Offer', subSubs: ['Gadget Combo', 'Accessories Combo', 'Budget Combo'] },
            { name: 'Gift Item', subSubs: ['Gadget Gift', 'Corporate Gift', 'Gift Box'] }
        ]
    },
    {
        id: 'MC5', name: 'Special Product', icon: 'fa-star', color: '#f59e0b',
        subs: [
            { name: 'Flash Deal', subSubs: ['Daily Flash Deal', 'Limited Stock Offer', 'Midnight Deal'] },
            { name: 'Best Selling', subSubs: ['Top Rated', 'Most Ordered', 'Trending Now'] },
            { name: 'New Arrival', subSubs: ['Just Arrived', 'New Collection', 'Latest Stock'] },
            { name: 'Hot Offer', subSubs: ['Hot Combo', 'Hot Discount', 'Mega Offer'] },
            { name: 'Premium Collection', subSubs: ['Premium Fashion', 'Premium Gadget', 'Premium Beauty', 'Premium Home'] },
            { name: 'Budget Bazar', subSubs: ['Under 300 Taka', 'Under 500 Taka', 'Under 1000 Taka'] },
            { name: 'Combo Offer', subSubs: ['Buy 1 Get 1', 'Buy 2 Get 1', 'Family Combo', 'Mega Combo'] },
            { name: 'Gift Item', subSubs: ['Gift for Him', 'Gift for Her', 'Kids Gift', 'Corporate Gift'] },
            { name: 'Exclusive Product', subSubs: ['Limited Edition', 'Exclusive Deal', 'VIP Product'] },
            { name: 'Festival Item', subSubs: ['Eid Special', 'Pohela Boishakh', 'Puja Special', 'Winter Special'] }
        ]
    },
    {
        id: 'MC6', name: 'Foods & Kids', icon: 'fa-burger', color: '#ef4444',
        subs: [
            { name: 'Food', subSubs: ['Rice & Grain', 'Spice', 'Oil & Ghee', 'Snacks', 'Dry Food', 'Pickle'] },
            { name: 'Beverage', subSubs: ['Tea & Coffee', 'Juice', 'Drink', 'Health Drink', 'Water'] },
            { name: 'Wet Food', subSubs: ['Fresh Food', 'Frozen Food', 'Ready Food', 'Homemade Food'] },
            { name: 'Health Food', subSubs: ['Honey', 'Dates', 'Nuts', 'Herbal Food', 'Organic Food'] },
            { name: 'Kids Toys', subSubs: ['Remote Control Toy', 'Educational Toy', 'Soft Toy', 'Puzzle', 'Baby Toy'] },
            { name: 'Baby Dress', subSubs: ['Baby Boy Set', 'Baby Girl Set', 'Newborn Dress', 'Winter Baby Dress'] },
            { name: 'Kids Dress', subSubs: ['Boys Shirt', 'Boys Pant', 'Girls Frock', 'Girls Top', 'Kids Combo'] },
            { name: 'Kids Footwear', subSubs: ['Kids Shoes', 'Kids Sandal', 'Kids Slipper', 'Baby Booties'] },
            { name: 'Baby Care', subSubs: ['Diaper', 'Baby Lotion', 'Baby Oil', 'Baby Wipes', 'Feeding Bottle'] },
            { name: 'Kids Accessories', subSubs: ['Kids Bag', 'Kids Cap', 'Kids Watch', 'Kids Hair Accessories'] },
            { name: 'Baby Food', subSubs: ['Baby Formula', 'Baby Cereal', 'Baby Juice', 'Baby Snacks'] },
            { name: 'Combo Offer', subSubs: ['Kids Combo', 'Food Combo', 'Baby Combo'] },
            { name: 'Gift Item', subSubs: ['Kids Gift', 'Baby Gift', 'Food Gift Box'] }
        ]
    }
];

/* The old flat seed is kept ONLY so an existing installation that already holds it
   can be recognised and upgraded in place. It is never written to a fresh DB. */
var LEGACY_DEFAULT_CATEGORIES = [
    { id: 1, name: "Men's Fashion", icon: "fa-shirt", count: 0, color: "#2563eb" },
    { id: 2, name: "Women's Fashion", icon: "fa-person-dress", count: 0, color: "#ec4899" },
    { id: 3, name: "Gadgets & Electronics", icon: "fa-mobile-screen", count: 0, color: "#8b5cf6" },
    { id: 4, name: "Home & Living", icon: "fa-couch", count: 0, color: "#f59e0b" },
    { id: 5, name: "Winter Collection", icon: "fa-snowflake", count: 0, color: "#06b6d4" },
    { id: 6, name: "Foods & Snacks", icon: "fa-burger", count: 0, color: "#ef4444" },
    { id: 7, name: "Kids Zone", icon: "fa-baby", count: 0, color: "#10b981" },
    { id: 8, name: "Gift Items", icon: "fa-gift", count: 0, color: "#f43f5e" },
    { id: 9, name: "Beauty & Health", icon: "fa-spray-can-sparkles", count: 0, color: "#d946ef" },
    { id: 10, name: "Sports & Fitness", icon: "fa-dumbbell", count: 0, color: "#14b8a6" }
];

/* Deep copy of the seed tree, so the constant can never be mutated at runtime. */
/* ---------------------------------------------------------------------------
   #21-#27 — the active Main Category structure.
   This is DATA (not code flow): the six mains with their Sub and Sub-Sub
   levels. It is UPSERTED by name, so existing records, ids, subs and every
   product relationship are preserved (#28) — nothing is deleted. Categories
   that are not part of this structure are flagged `primary:false` so they drop
   out of the active nav while their data stays intact.
   --------------------------------------------------------------------------- */
var RH_CATEGORY_STRUCTURE = {
    "Men's Fashion": {
        "Punjabi": ["Basic Punjabi", "Pajama", "Premium Punjabi"],
        "Pants": ["Formal Pants", "Gabardine Pants", "Jeans Pants", "Joggers", "Trousers"],
        "Shirts": ["Casual Shirt", "Double Pocket Shirt", "Formal Shirt", "Full Sleeve Shirt",
                   "Half Sleeve Shirt", "Polo Shirt", "Shirt Combo", "Solid Color Shirt"],
        "T-Shirts": ["Combo T-Shirt", "Cotton Fabric T-Shirt", "Drop Shoulder T-Shirt",
                     "Full Sleeve T-Shirt", "Half Sleeve T-Shirt", "Jersey Fabric T-Shirt"],
        "Men's Accessories": ["Watch", "Wallet", "Perfume", "Belt", "Sunglasses"],
        "Shoes": ["Sneakers", "Formal Shoes", "Casual Shoes", "Loafers", "Sandals",
                  "Sports Shoes", "Boots", "Slippers"]
    },
    "Women's Fashion": {
        "Saree": ["Cotton Saree", "Silk Saree", "Georgette Saree", "Designer Saree"],
        "Salwar Kameez": ["Cotton Salwar Kameez", "Designer Salwar Kameez", "Embroidered Salwar Kameez"],
        "Burqa": ["Abaya", "Hijab", "Niqab"],
        "Ladies Drop Shoulder T-Shirt": ["Cotton Drop Shoulder", "Printed Drop Shoulder"],
        "Ladies Bag": ["Hand Bag", "Shoulder Bag", "Clutch"],
        "Jewelry": ["Necklace", "Earrings", "Bracelet", "Ring", "Jewelry Set"],
        "Women's Accessories": ["Watch", "Perfume", "Hair Accessories"],
        "Shoes": ["Heels", "Sneakers", "Flats", "Sandals", "Wedges", "Loafers", "Boots", "Slippers"]
    },
    "Gadget & Electronics": {
        "Mobile Accessories": ["Earbuds & Bluetooth", "Cable & Charger", "Headphone",
                               "Mobile Phone", "Power Bank"],
        "Content Tool": ["Microphone", "Tripod Stand", "Video Kit"],
        "Electronics": ["Electronic Devices", "Tools & Accessories", "Router", "Shaver & Trimmer"],
        "Shaver & Trimmer": ["Shaver", "Trimmer", "Grooming Kit"],
        "IP Camera": ["Indoor Camera", "Outdoor Camera"],
        "Speaker": ["Bluetooth Speaker", "Home Theater"],
        "Fan Items": ["Table Fan", "Ceiling Fan", "Rechargeable Fan"],
        "Computer Items": ["Mouse & Keyboard", "Mouse", "Keyboard", "Computer Accessories"]
    },
    "Kids": {
        "Kids Dress": ["Frock", "Party Dress"],
        "Kids T-Shirt": ["Half Sleeve", "Full Sleeve"],
        "Kids Shirt": ["Casual Shirt", "Formal Shirt"],
        "Kids Toys": ["Learning Toys", "Indoor Toys", "Outdoor Toys"],
        "Baby Clothing": ["Newborn Set", "Baby Romper"],
        "Kids Pants": ["Jeans", "Shorts", "Joggers"],
        "Kids Accessories": ["Cap", "Socks", "School Bag"]
    },
    "Home & Lifestyle": {
        "Home Accessories": ["Curtain", "Cushion Cover", "Bedsheet"],
        "Kitchen & Dining": ["Cookware", "Dinner Set", "Storage Container"],
        "Home Organization": ["Shelf", "Storage Box"],
        "Decor": ["Wall Decor", "Showpiece", "Lighting"],
        "Personal Care": ["Skincare", "Hair Care", "Oral Care"],
        "Lifestyle Accessories": ["Umbrella", "Travel Bag"],
        "Daily Essentials": ["Cleaning Items", "Laundry Items"]
    },
    "Special Product": {
        "Trending Products": ["Trending Now", "Most Viewed"],
        "New Arrivals": ["Just In", "This Week"],
        "Premium Products": ["Premium Collection"],
        "Gift Items": ["Gift Set", "Occasion Gift"],
        "Unique Products": ["Handmade", "Exclusive"],
        "Seasonal Products": ["Summer", "Winter", "Eid Collection"],
        "Limited Collection": ["Limited Stock"]
    }
};
/* Idempotent upsert of that structure. Existing products/ids are untouched. */
function ensureCategoryStructure() {
    var marker = 'rh_cats_structure_v1';
    /* NOTE: deliberately NOT short-circuited on the marker. The upsert is idempotent
       and cheap, and a database can gain legacy rows after the first run (e.g. an
       in-place upgrade), in which case the six mains must be ensured again. */
    var list = asArray(getData(DB_KEYS.CATEGORIES));
    var byName = {};
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].name) byName[String(list[i].name).trim().toLowerCase()] = list[i];
    }
    var added = 0, flagged = 0;
    for (var main in RH_CATEGORY_STRUCTURE) {
        if (!Object.prototype.hasOwnProperty.call(RH_CATEGORY_STRUCTURE, main)) continue;
        var key = String(main).trim().toLowerCase();
        var cat = byName[key];
        if (!cat) {
            cat = { id: 'cat_' + Date.now() + Math.floor(Math.random() * 1000),
                    name: main, icon: 'fa-tag', image: '', subs: [], count: 0 };
            list.push(cat); byName[key] = cat; added++;
        }
        cat.primary = true;
        if (!cat.subs) cat.subs = [];
        for (var sub in RH_CATEGORY_STRUCTURE[main]) {
            if (!Object.prototype.hasOwnProperty.call(RH_CATEGORY_STRUCTURE[main], sub)) continue;
            var found = null;
            for (var k = 0; k < cat.subs.length; k++) {
                if (String((cat.subs[k] || {}).name || cat.subs[k]).trim().toLowerCase() === String(sub).trim().toLowerCase()) { found = cat.subs[k]; break; }
            }
            if (!found) {
                found = { name: sub, subSubs: [] };
                cat.subs.push(found);
            }
            if (typeof found === 'string') { found = { name: found, subSubs: [] }; cat.subs[k] = found; }
            if (!found.subSubs) found.subSubs = [];
            var want = RH_CATEGORY_STRUCTURE[main][sub] || [];
            for (var w = 0; w < want.length; w++) {
                var exists = false;
                for (var q = 0; q < found.subSubs.length; q++) {
                    if (String(found.subSubs[q] || '').trim().toLowerCase() === String(want[w]).trim().toLowerCase()) { exists = true; break; }
                }
                if (!exists) found.subSubs.push(want[w]);
            }
        }
    }
    /* keep old records, only drop them out of the active nav */
    var primaries = {};
    for (var m in RH_CATEGORY_STRUCTURE) { if (Object.prototype.hasOwnProperty.call(RH_CATEGORY_STRUCTURE, m)) primaries[String(m).trim().toLowerCase()] = 1; }
    for (var j = 0; j < list.length; j++) {
        var nm = String((list[j] || {}).name || '').trim().toLowerCase();
        if (nm && !primaries[nm] && list[j].primary !== false) { list[j].primary = false; flagged++; }
    }
    setData(DB_KEYS.CATEGORIES, list);
    try { localStorage.setItem(marker, '1'); } catch (e) {}
    return { changed: added + flagged, added: added, flagged: flagged };
}

function defaultCategoryTree() {
    return JSON.parse(JSON.stringify(MAIN_CATEGORY_TREE));
}


// Products - EMPTY by default, admin must add fresh ones
var DEFAULT_PRODUCTS = [];

var DEFAULT_ORDERS = [
    { id: "ORD-000001", resellerId: 1, resellerName: "Stylex Shopping", productId: 3, productName: "Wireless Bluetooth Earbuds", productPrice: 1100, productCost: 550, customer: "Mizanur Rahman", phone: "01711122334", address: "Dhanmondi, Dhaka", amount: 1100, profit: 550, qty: 1, size: "Free Size", color: "Black", status: "delivered", date: "2024-12-20", courier: "Steadfast", trackingId: "STD-2024-001", deliveryDate: "2024-12-22", note: "Delivered successfully", adminNote: "Customer was happy", trackingUrl: "https://steadfast.com.bd/track/STD-2024-001" },
    { id: "ORD-000002", resellerId: 1, resellerName: "Stylex Shopping", productId: 1, productName: "Men's Premium Polo Shirt", productPrice: 650, productCost: 350, customer: "Karim Hossain", phone: "01812345678", address: "Mirpur-10, Dhaka", amount: 1300, profit: 600, qty: 2, size: "L", color: "Blue", status: "shipped", date: "2024-12-22", courier: "Pathao", trackingId: "PTH-2024-002", deliveryDate: null, note: "In transit", adminNote: "", trackingUrl: "https://pathao.com/track/PTH-2024-002" },
    { id: "ORD-000003", resellerId: 1, resellerName: "Stylex Shopping", productId: 4, productName: "Smart Watch Pro Series", productPrice: 1500, productCost: 800, customer: "Jamal Uddin", phone: "01912345678", address: "Khulna Sadar", amount: 1500, profit: 700, qty: 1, size: "Free Size", color: "Black", status: "processing", date: "2024-12-24", courier: "", trackingId: "", deliveryDate: null, note: "Order placed", adminNote: "", trackingUrl: "" }
];

var DEFAULT_TRACKING = [
    { id: 1, orderId: "ORD-000001", status: "Order Placed", date: "2024-12-20 10:00 AM", location: "ResellerHub Warehouse", note: "Order received" },
    { id: 2, orderId: "ORD-000001", status: "Shipped", date: "2024-12-20 04:00 PM", location: "Steadfast Hub", note: "Handed over to courier" },
    { id: 3, orderId: "ORD-000001", status: "Delivered", date: "2024-12-22 02:00 PM", location: "Dhanmondi, Dhaka", note: "Delivered to customer" },
    { id: 4, orderId: "ORD-000002", status: "Order Placed", date: "2024-12-22 11:00 AM", location: "ResellerHub Warehouse", note: "Order received" },
    { id: 5, orderId: "ORD-000002", status: "Shipped", date: "2024-12-22 05:00 PM", location: "Pathao Hub", note: "In transit" },
    { id: 6, orderId: "ORD-000003", status: "Order Placed", date: "2024-12-24 09:00 AM", location: "ResellerHub Warehouse", note: "Order received" }
];

var DEFAULT_WITHDRAWALS = [];
var DEFAULT_NOTIFICATIONS = [
    { id: 1, userId: 1, type: "approval", message: "Your account has been approved. Start earning now!", date: "2024-01-01", read: false, persistent: true },
    { id: 2, userId: 1, type: "order_delivered", message: "Order ORD-000001 delivered! ৳550 profit added to your wallet.", date: "2024-12-22", read: false, persistent: false }
];

var DEFAULT_BANNERS = [
    { id: 1, title: "Mega Sale - Up to 50% Off!", subtitle: "Winter collection special offer", link: "#categories", active: true, color: "#dc2626" },
    { id: 2, title: "Join as Reseller - FREE!", subtitle: "Start your online business today", link: "reseller/register.html", active: true, color: "#2563eb" }
];

var DEFAULT_COUPONS = [
    { id: 1, code: "WELCOME100", discount: 100, type: "fixed", minOrder: 500, maxUses: 100, used: 0, expiryDate: "2025-12-31", status: "active", description: "৳100 off on first order" }
];

var DEFAULT_SETTINGS = {
    siteName: SITE_INFO.siteName,
    siteEmail: SITE_INFO.siteEmail,
    sitePhone: SITE_INFO.sitePhone,
    siteWebsite: SITE_INFO.siteWebsite,
    siteAddress: SITE_INFO.siteAddress,
    siteFacebook: SITE_INFO.facebook,
    siteYoutube: SITE_INFO.youtube,
    siteInstagram: SITE_INFO.instagram,
    minWithdraw: 500,
    maxWithdraw: 50000,
    codEnabled: true,
    autoApproveReseller: false,
    profitRate: 50,
    minOrderAmount: 100,
    deliveryCharge: 60,
    freeDeliveryAbove: 2000,
    referralBonus: 100,
    bkashNumber: "01997904792",
    nagadNumber: "01997904792",
    rocketNumber: "01997904792"
};

var DB_VERSION = '5';

// SUPPLIERS (vendors) - can upload products, create shop, but NOT touch other products
var DEFAULT_SUPPLIERS = [
    { id: 5001, name: "Maxx Fashion BD", shopName: "Maxx BD Store", sid: "SID-00101", email: "supplier@selfshop.com", password: "supplier123", phone: "01811111111", address: "Dhaka, Bangladesh", shopDescription: "Quality gadgets and electronics supplier", shopLogo: "", rating: 4.9, reviews: 43, status: "approved", joinDate: "2024-06-01", isSupplier: true, lastSeen: new Date().toISOString() }
];

function initDB() {
    // FORCE RESET when code version changes - removes all old dummy data
    var storedVer = localStorage.getItem('rh_db_version');
    if (storedVer !== DB_VERSION) {
        var keysToRemove = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf('rh_') === 0) keysToRemove.push(k);
        }
        for (var j = 0; j < keysToRemove.length; j++) localStorage.removeItem(keysToRemove[j]);
        localStorage.setItem('rh_db_version', DB_VERSION);
    }
    if (!localStorage.getItem(DB_KEYS.PRODUCTS)) localStorage.setItem(DB_KEYS.PRODUCTS, JSON.stringify(DEFAULT_PRODUCTS));
    if (!localStorage.getItem(DB_KEYS.ORDERS)) localStorage.setItem(DB_KEYS.ORDERS, JSON.stringify(DEFAULT_ORDERS));
    if (!localStorage.getItem(DB_KEYS.RESELLERS)) localStorage.setItem(DB_KEYS.RESELLERS, JSON.stringify([STYLEX_ACCOUNT]));
    if (!localStorage.getItem(DB_KEYS.WITHDRAWALS)) localStorage.setItem(DB_KEYS.WITHDRAWALS, JSON.stringify(DEFAULT_WITHDRAWALS));
    if (!localStorage.getItem(DB_KEYS.CATEGORIES)) localStorage.setItem(DB_KEYS.CATEGORIES, JSON.stringify(defaultCategoryTree()));
    migrateCategoryTree();
    /* 2026-09-15 — repair supplier ratings stored by the old phantom-5-star maths.
       Idempotent (marker key); never bumps DB_VERSION. */
    try { migrateSupplierRatings(); } catch (e) {}
    /* #21-#27 — add the active Main Category structure (upsert by name: existing
       category records, ids and product relationships are preserved). */
    try { ensureCategoryStructure(); } catch (e) {}
    /* BUG FIX — MAIN_CATEGORY_NAMES used the non-apostrophe spelling ("Men Fashion")
       while the live six use the apostrophe form ("Men's Fashion"). The migration's
       retire step therefore marked apostrophe-form primary categories as
       `hidden:true`, which made EVERY product in those categories invisible in the
       storefront (isCategoryVisible returns false). We now un-hide any primary
       category that was wrongly marked hidden by the previous migration. */
    try { unhideWronglyRetiredPrimaries(); } catch (e) {}
    if (!localStorage.getItem(DB_KEYS.NOTIFICATIONS)) localStorage.setItem(DB_KEYS.NOTIFICATIONS, JSON.stringify(DEFAULT_NOTIFICATIONS));
    if (!localStorage.getItem(DB_KEYS.SETTINGS)) localStorage.setItem(DB_KEYS.SETTINGS, JSON.stringify(DEFAULT_SETTINGS));
    if (!localStorage.getItem(DB_KEYS.SUPPORT)) localStorage.setItem(DB_KEYS.SUPPORT, JSON.stringify([]));
    if (!localStorage.getItem(DB_KEYS.BANNERS)) localStorage.setItem(DB_KEYS.BANNERS, JSON.stringify(DEFAULT_BANNERS));
    if (!localStorage.getItem(DB_KEYS.COUPONS)) localStorage.setItem(DB_KEYS.COUPONS, JSON.stringify(DEFAULT_COUPONS));
    if (!localStorage.getItem(DB_KEYS.TRACKING)) localStorage.setItem(DB_KEYS.TRACKING, JSON.stringify(DEFAULT_TRACKING));
    if (!localStorage.getItem(DB_KEYS.ACTIVITY)) localStorage.setItem(DB_KEYS.ACTIVITY, JSON.stringify([]));
    if (!localStorage.getItem(DB_KEYS.SIZES)) localStorage.setItem(DB_KEYS.SIZES, JSON.stringify(DEFAULT_SIZES));
    if (!localStorage.getItem(DB_KEYS.COLORS)) localStorage.setItem(DB_KEYS.COLORS, JSON.stringify(DEFAULT_COLORS));
    if (!localStorage.getItem(DB_KEYS.SECTIONS)) localStorage.setItem(DB_KEYS.SECTIONS, JSON.stringify(DEFAULT_SECTIONS));
    if (!localStorage.getItem(DB_KEYS.SUB_SECTIONS)) localStorage.setItem(DB_KEYS.SUB_SECTIONS, JSON.stringify(DEFAULT_SUB_SECTIONS));
    if (!localStorage.getItem(DB_KEYS.VERSIONS)) localStorage.setItem(DB_KEYS.VERSIONS, JSON.stringify(DEFAULT_VERSIONS));
    if (!localStorage.getItem(DB_KEYS.ONLINE)) localStorage.setItem(DB_KEYS.ONLINE, JSON.stringify({}));
    if (!localStorage.getItem(DB_KEYS.SUPPLIERS)) localStorage.setItem(DB_KEYS.SUPPLIERS, JSON.stringify(DEFAULT_SUPPLIERS));
    if (!localStorage.getItem(DB_KEYS.REVIEWS)) localStorage.setItem(DB_KEYS.REVIEWS, JSON.stringify([]));
    normalizeOrderOwnership();
    /* Storage pressure: if the origin is close to its localStorage budget, trim
       the unbounded history NOW and (in the background) downscale the biggest
       stored images. Without this, the shop silently stops accepting orders the
       moment the budget runs out — every write throws.
       DEFERRED: measuring the store means reading every value, which on a full
       ~5 MB origin is real work. It must not delay first paint, so it runs right
       after the current task instead of inside initDB(). */
    try { setTimeout(function () { try { rhAutoCompactIfNeeded(); } catch (e) { } }, 0); } catch (e) { }
    /* Boot the IndexedDB image store: hydrate the in-memory cache, move any images
       still living in localStorage across, and fix <img> tags that still hold a
       ref. This is what removes the ~5 MB ceiling. */
    try { rhImgStoreBoot(); } catch (e) { }
}
/* How full is the origin? We cannot read the real quota, so we use a conservative
   working budget, PLUS a per-key check: one image-bearing key that has grown past
   ~1.2 MB is on its own a strong signal that photos are eating the budget. */
var RH_WORKING_BUDGET = 4.5 * 1024 * 1024;   /* ~4.5 MB of the usual 5 MB */
var RH_BIG_KEY_BYTES = 1.2 * 1024 * 1024;
function rhAutoCompactIfNeeded() {
    var used = rhStorageTotal();
    var bigKey = false;
    var rep = rhStorageReport();
    for (var i = 0; i < rep.length && i < 3; i++) {
        if (rep[i].bytes > RH_BIG_KEY_BYTES) { bigKey = true; break; }
    }
    if (used <= RH_WORKING_BUDGET * 0.7 && !bigKey) return { used: used, acted: false };
    /* 1. free the cheap stuff synchronously (history logs) */
    rhFreeSpace('');
    /* 2. then, if it is still tight (or a single key is oversized), downscale the
          biggest stored images in the background so the next order can be saved. */
    if (bigKey || rhStorageTotal() > RH_WORKING_BUDGET * 0.8) {
        setTimeout(function () { try { rhCompactStoredImages(function () { }, 12); } catch (e) { } }, 1200);
    }
    return { used: used, acted: true };
}

/* ---------------------------------------------------------------------------
   CATEGORY TREE MIGRATION (items 19-22) — ADDITIVE, NEVER DESTRUCTIVE.
   An existing installation may hold the old flat 10-category seed. We must upgrade
   it to the 6-category hierarchy WITHOUT wiping anything and WITHOUT bumping
   DB_VERSION (a bump would delete every rh_* key, breaking the "do not delete data"
   rule). So this migration:
     1. keeps every category the admin already created, with its subs and subSubs;
     2. adds any of the 6 main categories that is missing, WITH its full tree;
     3. fills in the sub / sub-sub levels of an existing main category only where
        that level is still empty (an admin's own edits always win);
     4. records what it did under a version marker so it runs at most once per
        recognised shape.
   Idempotent: running it twice changes nothing.
   --------------------------------------------------------------------------- */
function categoryMigrateMarker() {
    try { return String(localStorage.getItem('rh_cats_migrated') || ''); } catch (e) { return ''; }
}
function setCategoryMigrateMarker(v) {
    try { localStorage.setItem('rh_cats_migrated', String(v)); } catch (e) {}
}
function findCategoryByName(list, name) {
    var want = String(name || '').trim().toLowerCase();
    for (var i = 0; i < list.length; i++) {
        if (!list[i]) continue;
        if (String(list[i].name || '').trim().toLowerCase() === want) return list[i];
    }
    return null;
}
/* The canonical spelling of a main-category name, matched case-insensitively
   against the six PRIMARY names. Returns '' when the name is not one of them. */
function canonicalMainName(name) {
    var want = String(name || '').trim().toLowerCase();
    for (var i = 0; i < MAIN_CATEGORY_NAMES.length; i++) {
        if (String(MAIN_CATEGORY_NAMES[i]).trim().toLowerCase() === want) return MAIN_CATEGORY_NAMES[i];
    }
    return '';
}
/* Move every sub / sub-sub of `from` into `into` without losing anything and
   without duplicating a name. Used to fold a legacy duplicate main category. */
function mergeCategoryInto(into, from) {
    if (!into || !from) return;
    if (!into.subs) into.subs = [];
    var srcSubs = asArray(from.subs);
    for (var i = 0; i < srcSubs.length; i++) {
        var s = srcSubs[i];
        var nm = catEntryName(s);
        if (!nm) continue;
        var hit = null;
        for (var j = 0; j < into.subs.length; j++) {
            if (catEntryName(into.subs[j]).toLowerCase() === nm.toLowerCase()) { hit = into.subs[j]; break; }
        }
        if (!hit) {
            into.subs.push(typeof s === 'object' ? JSON.parse(JSON.stringify(s)) : { name: nm, subSubs: [] });
            continue;
        }
        var dst = asArray(hit.subSubs);
        var src = asArray(s && typeof s === 'object' ? s.subSubs : []);
        for (var k = 0; k < src.length; k++) {
            var v = catEntryName(src[k]);
            if (!v) continue;
            var already = false;
            for (var q = 0; q < dst.length; q++) if (catEntryName(dst[q]).toLowerCase() === v.toLowerCase()) { already = true; break; }
            if (!already) dst.push(v);
        }
        hit.subSubs = dst;
    }
    if (!into.icon && from.icon) into.icon = from.icon;
    if (!into.color && from.color) into.color = from.color;
}
function categoryTreeSync(oldName, newName) {
    /* Same main category under an older spelling (e.g. "Men's Fashion" -> "Men Fashion").
       A pure alias map so returning admins keep their products pointing at a live name. */
    return String(oldName || '').trim().toLowerCase() === String(newName || '').trim().toLowerCase();
}
/* Which legacy main-category name corresponds to a new one, if any. */
var CATEGORY_RENAME_ALIASES = {
    'men fashion': "men's fashion",
    'women fashion': "women's fashion",
    'gadget & electronics': 'gadgets & electronics',
    'foods & kids': 'foods & snacks'
};
function migrateCategoryTree() {
    if (categoryMigrateMarker() === 'v6') return { changed: 0, reason: 'already' };
    var list = getData(DB_KEYS.CATEGORIES);
    if (Object.prototype.toString.call(list) !== '[object Array]') list = [];
    var added = 0, renamed = 0;

    /* 1. alias-rename a legacy main category in place, preserving its subs/subSubs.
       Match CASE-INSENSITIVELY (so "men's fashion", "Men's Fashion" and
       "MEN'S FASHION" are all recognised) and write the EXACT canonical spelling
       from MAIN_CATEGORY_TREE — never a mangled title-case of the lookup key.
       The alias key must NEVER be applied to a record that is already carrying
       the canonical name, and we never write an empty name. */
    for (var alias in CATEGORY_RENAME_ALIASES) {
        if (!Object.prototype.hasOwnProperty.call(CATEGORY_RENAME_ALIASES, alias)) continue;
        var canonical = canonicalMainName(CATEGORY_RENAME_ALIASES[alias]);
        if (!canonical) continue;                              /* no such primary */
        if (findCategoryByName(list, canonical)) continue;      /* already present */
        var legacy = findCategoryByName(list, alias);
        if (!legacy) continue;
        if (canonicalMainName(legacy.name)) continue;           /* already canonical itself */
        legacy.name = canonical;
        renamed++;
    }

    /* 1b. DEDUPE: a legacy install can end up carrying the same main category
       twice (old "Men's Fashion" + a hand-added "Men Fashion"). Fold the
       duplicate into the canonical record, merging its subs/sub-subs in — the
       duplicate's data is preserved, never dropped, and never both survive as
       two primary nav entries (item 17 demands exactly six). */
    for (var d = list.length - 1; d >= 0; d--) {
        var dup = list[d];
        if (!dup || !dup.name) continue;
        var canonName = canonicalMainName(dup.name);
        if (!canonName || canonName === dup.name) continue;    /* already canonical */
        var keep = findCategoryByName(list, canonName);
        if (!keep || keep === dup) continue;
        mergeCategoryInto(keep, dup);
        list.splice(d, 1);
        renamed++;
    }

    /* 2/3. add the six main categories, or fill in the levels that are still empty */
    for (var i = 0; i < MAIN_CATEGORY_TREE.length; i++) {
        var seed = MAIN_CATEGORY_TREE[i];
        var cur = findCategoryByName(list, seed.name);
        if (!cur) {
            var fresh = JSON.parse(JSON.stringify(seed));
            fresh.count = 0;
            list.push(fresh);
            added++;
            continue;
        }
        /* keep the admin's identity fields, only top up the missing structure */
        if (!cur.icon) cur.icon = seed.icon;
        if (!cur.color) cur.color = seed.color;
        if (!cur.subs) cur.subs = [];
        /* the old flat seed had no subs for some names — build them from the tree */
        for (var j = 0; j < seed.subs.length; j++) {
            var sSeed = seed.subs[j];
            var sCur = null;
            for (var k = 0; k < cur.subs.length; k++) {
                if (categoryTreeSync((cur.subs[k] || {}).name, sSeed.name)) { sCur = cur.subs[k]; break; }
            }
            if (!sCur) {
                cur.subs.push({ name: sSeed.name, subSubs: sSeed.subSubs.slice() });
                continue;
            }
            if (!sCur.subSubs) sCur.subSubs = [];
            if (!sCur.subSubs.length) sCur.subSubs = sSeed.subSubs.slice();
        }
        /* legacy shape stored the mapping as { subName: [ ... ] } — migrate it */
        if (cur.subSubs && typeof cur.subSubs === 'object' && Object.prototype.toString.call(cur.subSubs) !== '[object Array]') {
            for (var subName in cur.subSubs) {
                if (!Object.prototype.hasOwnProperty.call(cur.subSubs, subName)) continue;
                var found = null;
                for (var m = 0; m < cur.subs.length; m++) if (categoryTreeSync((cur.subs[m] || {}).name, subName)) { found = cur.subs[m]; break; }
                if (!found) { found = { name: subName, subSubs: [] }; cur.subs.push(found); }
                for (var p = 0; p < (cur.subSubs[subName] || []).length; p++) {
                    var v = cur.subSubs[subName][p];
                    if (found.subSubs.indexOf(v) === -1) found.subSubs.push(v);
                }
            }
            delete cur.subSubs;
        }
    }

    /* 4. RETIRE the legacy flat seed's extra mains from PRIMARY nav (items 17/18).
       The old install shipped 10 flat categories (Men's Fashion, Home & Living,
       Winter Collection, Kids Zone, Gift Items, Beauty & Health, Sports & Fitness …).
       Those that are not one of the six PRIMARY names must stop being primary nav.
       We NEVER delete them — the record, its subs and sub-subs all stay in the
       database, and an admin can re-enable any of them from Main Category
       Management. We only set a visibility flag, which is exactly the mechanism
       the app already uses (isCategoryVisible / setCategoryVisible). */
    var retired = 0;
    for (var r = 0; r < list.length; r++) {
        var cat = list[r];
        if (!cat || !cat.name) continue;
        if (isPrimaryMainCategory(cat.name)) continue;      /* one of the six */
        /* "Winter Collection" and "Combo Offer" also exist as SUB names inside
           the new tree; a top-level category carrying that name is legacy. */
        if (isCategoryVisibleLocal(list, r)) { cat.hidden = true; retired++; }
    }

    saveCategories(list);
    setCategoryMigrateMarker('v6');
    return { changed: added + renamed + retired, added: added, renamed: renamed, retired: retired };
}

/* Does this name belong to the six PRIMARY main categories? */
function isPrimaryMainCategory(name) {
    var want = String(name || '').trim().toLowerCase();
    for (var i = 0; i < MAIN_CATEGORY_NAMES.length; i++) {
        if (String(MAIN_CATEGORY_NAMES[i]).trim().toLowerCase() === want) return true;
    }
    return false;
}
/* BUG FIX — counter the legacy retire-step that hid apostrophe-form primaries.
   Iterates rh_categories, un-hides any record that IS one of the canonical primary
   names but was wrongly marked hidden:true. Idempotent (re-running is a no-op). */
function unhideWronglyRetiredPrimaries() {
    var list = getData(DB_KEYS.CATEGORIES);
    if (Object.prototype.toString.call(list) !== '[object Array]') return { changed: 0 };
    var changed = 0;
    for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !c.name) continue;
        if (!isPrimaryMainCategory(c.name)) continue;
        if (c.hidden === true) { c.hidden = false; changed++; }
    }
    if (changed) saveCategories(list);
    return { changed: changed };
}
/* local helper: is index r already hidden? (avoids depending on load order) */
function isCategoryVisibleLocal(list, idx) {
    var c = list[idx];
    return !(c && c.hidden === true);
}

/* ---------------------------------------------------------------------------
   ORDER OWNERSHIP BACK-FILL (non-destructive, idempotent)
   ---------------------------------------------------------------------------
   Older / mixed orders can be missing the ownership field the list pages used
   to require (`resellerId`), which made a real order invisible in its owner's
   views even though it existed. This walks the stored orders and FILLS IN only
   what is missing, derived from data already on the order:
     · a line's product_owner_id / ownerResellerId / shop_id  -> order.resellerId
     · a line's supplierId / supplier_id                      -> line.supplierId
   It never deletes an order, never overwrites an existing value, and never
   invents ownership that no line supports. Running it twice changes nothing.
   --------------------------------------------------------------------------- */
function normalizeOrderOwnership() {
    try {
        var orders = getData(DB_KEYS.ORDERS) || [], changed = false;
        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            if (!o) continue;
            var items = orderLineItems(o);
            /* 1. fill the order's owning reseller from its own-product lines */
            if ((o.resellerId === undefined || o.resellerId === null || o.resellerId === '') && items.length) {
                for (var j = 0; j < items.length; j++) {
                    var it = items[j] || {};
                    var owner = null;
                    if (String(it.product_owner_type || it.product_source || '').toLowerCase() === 'reseller') {
                        owner = (it.product_owner_id !== undefined && it.product_owner_id !== null) ? it.product_owner_id : it.ownerResellerId;
                    }
                    if ((owner === undefined || owner === null || owner === '') && (it.ownerResellerId !== undefined && it.ownerResellerId !== null)) owner = it.ownerResellerId;
                    if ((owner === undefined || owner === null || owner === '') && it.shop_id !== undefined && it.shop_id !== null && String(it.product_source || '').toLowerCase() === 'reseller') owner = it.shop_id;
                    if (owner !== undefined && owner !== null && owner !== '') { o.resellerId = owner; changed = true; break; }
                }
            }
            /* 2. make sure every line carries the supplier field the supplier
                  panel renders from (existing value is never overwritten) */
            if (o.items && o.items.length) {
                for (var k = 0; k < o.items.length; k++) {
                    var ln = o.items[k];
                    if (!ln) continue;
                    if (ln.supplierId === undefined || ln.supplierId === null) {
                        var p = findProductById(ln.productId);
                        var ps = p ? ((p.supplierId !== undefined && p.supplierId !== null) ? p.supplierId : p.supplier_id) : null;
                        if (ps === undefined) ps = null;
                        var ls = (ln.supplier_id !== undefined && ln.supplier_id !== null) ? ln.supplier_id : null;
                        var use = (ps !== null) ? ps : ls;
                        if (use !== null && use !== undefined) { ln.supplierId = use; changed = true; }
                    }
                }
            }
        }
        if (changed) setData(DB_KEYS.ORDERS, orders);
    } catch (e) { /* never block the app on a repair pass */ }
}

/* ==========================================================================
   INDEXEDDB IMAGE STORE — the answer to "storage is full"
   --------------------------------------------------------------------------
   localStorage is hard-capped at roughly 5-10 MB PER ORIGIN and that cap CANNOT
   be raised from code — it is a browser setting, not an app setting. Product
   photos are base64 strings and are by far the biggest payload, so a few dozen
   products already fill the budget and then EVERY write fails (including a new
   order).

   IndexedDB is a different store with a far larger quota (typically a large
   fraction of free disk space). So every image string is moved there and replaced
   in localStorage by a tiny `@img:<id>` reference.

   The app's data layer is synchronous (getData/setData), so:
     · setData() spills big image strings to IndexedDB and writes only the refs
     · getData()/getOne() resolve refs back from an in-memory cache
     · rhResolveImgTags() fixes any <img> that still holds a ref — installed here,
       so NO page has to change
   Everything is best-effort and degrades safely: if IndexedDB is unavailable
   (e.g. some browsers block it on file://) the old inline behaviour is kept and
   nothing breaks.
   ========================================================================== */
var RH_IMG_DB = 'rh_imgstore', RH_IMG_OBJ = 'imgs';
var RH_IMG_REF = '@img:';
var RH_IMG_SPILL_MIN = 8192;      /* spill any data:image string longer than this */
var RH_IMG_MARK = 'rh_img_spilled_v1';
var _rhImgCache = {};
var _rhImgReady = false;
var _rhImgAvailable = null;       /* null = unknown, true/false once probed */
var _rhImgDbP = null;
var _rhImgSeq = 0;
var _rhImgPending = [];           /* [id, dataUrl] queued for IndexedDB */

function rhImgDb() {
    if (_rhImgDbP) return _rhImgDbP;
    _rhImgDbP = new Promise(function (resolve) {
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB) { _rhImgAvailable = false; resolve(null); return; }
            var req = indexedDB.open(RH_IMG_DB, 1);
            req.onupgradeneeded = function () {
                try { var db = req.result; if (!db.objectStoreNames.contains(RH_IMG_OBJ)) db.createObjectStore(RH_IMG_OBJ); } catch (e) { }
            };
            req.onsuccess = function () { _rhImgAvailable = true; resolve(req.result); };
            req.onerror = function () { _rhImgAvailable = false; resolve(null); };
            req.onblocked = function () { _rhImgAvailable = false; resolve(null); };
        } catch (e) { _rhImgAvailable = false; resolve(null); }
    });
    return _rhImgDbP;
}
function rhImgPut(id, dataUrl) {
    /* 2026-09-17 — mirror to the shared store so other devices can see it. */
    try { rhStorePushImg(id, dataUrl); } catch (e0) { }
    /* …and make it renderable in THIS page straight away. _rhImgCache is what
       rhImgUrl() reads; IndexedDB alone is not enough until the next load.
       Deliberately BEFORE the IndexedDB call: it must not depend on the database
       opening (a browser with IndexedDB blocked would otherwise show placeholders). */
    try { _rhImgCache[id] = dataUrl; } catch (e1) { }
    rhImgDb().then(function (db) {
        if (!db) return;
        try {
            var tx = db.transaction(RH_IMG_OBJ, 'readwrite');
            tx.objectStore(RH_IMG_OBJ).put(dataUrl, id);
        } catch (e) { }
    });
}
/* Persist a whole batch of spilled images and REPORT failure. The single-image
   rhImgPut() above is fire-and-forget: it cannot tell a caller that the bytes
   never landed, which is exactly how an image used to disappear. `onFail` runs
   once if the batch could not be written at all. */
/* 2026-09-17 — mirror spilled image bytes to the shared store so every device can
   see them. IndexedDB is PER BROWSER, so without this an image uploaded by a reseller
   renders as a placeholder everywhere else — which is exactly what was happening.
   Keyed `rh_img_<id>` so the existing store sync carries it automatically. */
function rhStorePushImg(id, dataUrl) {
    if (!RH_STORE_ON) return;
    try {
        fetch('/api/store', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'rh_img_' + id, value: dataUrl }) }).catch(function () { });
    } catch (e) { }
}
function rhImgPutAll(pending, onFail) {
    /* 2026-09-17 — fill the in-memory cache FIRST, unconditionally.
       _rhImgCache is what rhImgUrl() reads. Doing this inside the IndexedDB
       callback means a browser without IndexedDB (or a jsdom test) never caches
       anything and every image renders as a placeholder. */
    try {
        for (var _c = 0; _c < pending.length; _c++) { _rhImgCache[pending[_c][0]] = pending[_c][1]; }
    } catch (eC) { }
    if (!pending || !pending.length) return;
    var reported = false;
    function fail() { if (!reported) { reported = true; if (onFail) onFail(); } }
    try {
        rhImgDb().then(function (db) {
            if (!db) { fail(); return; }
            try {
                var tx = db.transaction(RH_IMG_OBJ, 'readwrite');
                var os = tx.objectStore(RH_IMG_OBJ);
                for (var i = 0; i < pending.length; i++) {
            os.put(pending[i][1], pending[i][0]);
            /* 2026-09-17 — and mirror each one to the shared store. */
            try { rhStorePushImg(pending[i][0], pending[i][1]); } catch (e2) { }
            /* …and put it in the in-memory cache so rhImgUrl() can resolve it NOW.
               Without this the bytes reach IndexedDB but the page still renders a
               placeholder until the next full load — which is exactly what a fresh
               device saw after the store sync. */
            try { _rhImgCache[pending[i][0]] = pending[i][1]; } catch (e3) { }
        }
                tx.oncomplete = function () { };
                tx.onerror = fail;
                tx.onabort = fail;
            } catch (e) { fail(); }
        });
    } catch (e) { fail(); }
}
function rhImgLoadAll(cb) {
    rhImgDb().then(function (db) {
        if (!db) { _rhImgReady = true; if (cb) cb(0); return; }
        var n = 0;
        try {
            var tx = db.transaction(RH_IMG_OBJ, 'readonly');
            var req = tx.objectStore(RH_IMG_OBJ).openCursor();
            req.onsuccess = function () {
                var cur = req.result;
                if (cur) { _rhImgCache[cur.key] = cur.value; n++; cur.continue(); }
            };
            tx.oncomplete = function () { _rhImgReady = true; if (cb) cb(n); };
            tx.onerror = function () { _rhImgReady = true; if (cb) cb(n); };
            tx.onabort = function () { _rhImgReady = true; if (cb) cb(n); };
        } catch (e) { _rhImgReady = true; if (cb) cb(0); }
    });
}
function rhImgIsRef(s) { return typeof s === 'string' && s.indexOf(RH_IMG_REF) === 0; }
function rhImgUrl(ref) {
    if (!ref) return '';
    if (!rhImgIsRef(ref)) return ref;                    /* already a real URL */
    return _rhImgCache[ref.slice(RH_IMG_REF.length)] || '';
}
function rhImgNewId() {
    return 'i' + Date.now().toString(36) + (_rhImgSeq++).toString(36) + Math.random().toString(36).slice(2, 7);
}
/* 2026-09-15 — THE safe way to turn a stored product image into an <img src>.
   A big image is moved to IndexedDB and replaced by an `@img:<id>` marker
   (see RH_IMG_REF). Rendering that marker straight into `<img src="...">` makes
   the browser request a file literally named "@img:i..." and log
   ERR_FILE_NOT_FOUND — which is exactly what the My Shop grid was doing.
   Resolve the reference; if it cannot be resolved (bytes not reachable from this
   origin), return '' so the caller shows its own placeholder instead of a broken
   image. An empty string is honest; a leaked marker is a console full of errors. */
/* ==========================================================================
   SEO  (2026-09-17, this request)
   --------------------------------------------------------------------------
   A client-side page cannot change what a crawler already fetched, but it CAN set
   the title, the meta description, the keywords, the canonical URL and the social
   share card for the page it is rendering — which is what a link preview and a
   browser tab actually read. These helpers do exactly that, and nothing else.
   Blank values fall back to what the page already had, so an unfilled SEO field
   never produces an empty tag.
   ========================================================================== */
function seoSetMeta(attr, name, content) {
    try {
        if (!content) return;
        var sel = 'meta[' + attr + '="' + name + '"]';
        var el = document.head ? document.head.querySelector(sel) : null;
        if (!el) {
            el = document.createElement('meta');
            el.setAttribute(attr, name);
            if (document.head) document.head.appendChild(el);
        }
        el.setAttribute('content', String(content));
    } catch (e) { }
}
/* Apply a product's SEO. Anything blank falls back to the product's own name and
   description, so the tags are never empty. */
function applyProductSeo(p, shopName) {
    try {
        if (!p) return;
        var name = String(p.name || '');
        var title = String(p.seoTitle || '').trim() || (name + (shopName ? ' | ' + shopName : ''));
        var desc = String(p.seoDescription || '').trim() || String(p.description || '').trim() || name;
        var keys = String(p.seoKeywords || '').trim() || [name, p.category, p.subSection, shopName].filter(Boolean).join(', ');
        document.title = title;
        seoSetMeta('name', 'description', desc.slice(0, 300));
        seoSetMeta('name', 'keywords', keys);
        seoSetMeta('property', 'og:title', title);
        seoSetMeta('property', 'og:description', desc.slice(0, 300));
        seoSetMeta('property', 'og:type', 'product');
        seoSetMeta('name', 'twitter:card', 'summary_large_image');
        seoSetMeta('name', 'twitter:title', title);
        seoSetMeta('name', 'twitter:description', desc.slice(0, 300));
        var img = '';
        try { img = (typeof productPrimaryImage === 'function') ? (productPrimaryImage(p) || '') : ''; } catch (e) { }
        if (img) { seoSetMeta('property', 'og:image', img); seoSetMeta('name', 'twitter:image', img); }
        if (p.seoSlug) seoSetMeta('name', 'slug', p.seoSlug);
    } catch (e) { }
}
/* Apply a shop's SEO. */
function applyShopSeo(shop, rid) {
    try {
        if (!shop) return;
        var nm = '';
        try { nm = resellerBusinessName(shop) || ''; } catch (e) { nm = shop.businessName || shop.shopName || shop.name || ''; }
        /* The SEO fields are saved with the shop SETTINGS (rh_shop_settings), so read
           them from there first; the reseller record is the fallback. */
        var st = {};
        try {
            var all = getData(DB_KEYS.SHOP_SETTINGS) || {};
            st = all[String(rid || shop.id)] || {};
        } catch (e) { st = {}; }
        var pick = function (k) { return String((st[k] !== undefined ? st[k] : shop[k]) || '').trim(); };
        var title = pick('seoTitle') || nm;
        var desc = pick('seoDescription') || String(shop.shopDescription || '').trim() || nm;
        var keys = pick('seoKeywords') || [nm, 'online shop', 'Bangladesh'].filter(Boolean).join(', ');
        document.title = title;
        seoSetMeta('name', 'description', desc.slice(0, 300));
        seoSetMeta('name', 'keywords', keys);
        seoSetMeta('property', 'og:title', title);
        seoSetMeta('property', 'og:description', desc.slice(0, 300));
        seoSetMeta('property', 'og:type', 'website');
        var logo = shop.shop_logo || shop.shopLogo || shop.logo || '';
        if (logo) seoSetMeta('property', 'og:image', logo);
    } catch (e) { }
}
/* ==========================================================================
   SHOW / HIDE PASSWORD  (2026-09-17, this request)
   --------------------------------------------------------------------------
   Every password field gets an eye button. The user asked for this on the
   registration forms (reseller, supplier, admin) and the login forms, so it is
   installed ONCE here and every page gets it — including fields that are added
   later by a render, which the MutationObserver picks up.
   Each field is wrapped in a span so the button can sit over its right edge. The
   wrapper copies the input's own width behaviour, so existing layouts keep working.
   ========================================================================== */
function rhPasswordEyeInstall(inp) {
    try {
        if (!inp || inp.getAttribute('data-rh-eye') === '1') return;
        if (String(inp.type || '').toLowerCase() !== 'password') return;
        /* 2026-09-17 — some login pages ALREADY ship their own show/hide eye. Adding
           ours as well put TWO eyes on the same field. The page's own button is
           usually parsed AFTER the input (it is a later sibling inside a
           position:relative wrapper), so a one-shot sibling check is not enough —
           the observer could fire between the two. We therefore (a) test for a
           native eye every time, and (b) re-sweep on each tick and pull our own eye
           back out if a native one shows up later. */
        if (rhPasswordEyeNative(inp)) return;
        inp.setAttribute('data-rh-eye', '1');

        var wrap = document.createElement('span');
        wrap.className = 'rh-pw';
        var origParent = inp.parentNode;
        origParent.insertBefore(wrap, inp);
        wrap.appendChild(inp);
        try { wrap.__rhOrigParent = origParent; } catch (e) { }

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rh-pw-eye';
        btn.setAttribute('aria-label', 'Show password');
        btn.setAttribute('tabindex', '-1');
        btn.innerHTML = '<i class="fas fa-eye"></i>';
        btn.onclick = function () {
            var show = inp.type === 'password';
            inp.type = show ? 'text' : 'password';
            btn.innerHTML = show ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
            btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
            try { inp.focus(); } catch (e) { }
        };
        wrap.appendChild(btn);
    } catch (e) { }
}
/* Does this password field already have a page-native show/hide eye next to it?
   Searched from the field's ORIGINAL container (kept on our wrapper) so the test
   still works after we have wrapped the input. Our own .rh-pw-eye is ignored. */
function rhPasswordEyeNative(inp) {
    try {
        if (!inp) return false;
        var wrap = inp.parentNode;
        var orig = (wrap && wrap.__rhOrigParent) ? wrap.__rhOrigParent : wrap;
        if (!orig || !orig.querySelectorAll) return false;
        var kids = orig.querySelectorAll('button, i, span, a, svg');
        for (var z = 0; z < kids.length; z++) {
            var el = kids[z];
            try { if (el.closest && el.closest('.rh-pw')) continue; } catch (e) { }
            var cl = String(el.className || '');
            if (typeof cl !== 'string') cl = String((cl && cl.baseVal) || '');
            if (cl.indexOf('fa-eye') !== -1 || cl.indexOf('eye') !== -1) return true;
            if (el.getAttribute && el.getAttribute('aria-label') &&
                /show password|hide password/i.test(el.getAttribute('aria-label'))) return true;
        }
    } catch (e) { }
    return false;
}
/* Undo our wrapper, putting the input back exactly where it was. */
function rhPasswordEyeRemove(inp) {
    try {
        var wrap = inp.parentNode;
        if (!wrap || !wrap.classList || !wrap.classList.contains('rh-pw')) return;
        var orig = wrap.__rhOrigParent;
        if (!orig) return;
        orig.insertBefore(inp, wrap);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        inp.removeAttribute('data-rh-eye');
    } catch (e) { }
}
function rhPasswordEyes(root) {
    try {
        var scope = root || document;
        var list = scope.querySelectorAll ? scope.querySelectorAll('input[type="password"]') : [];
        for (var i = 0; i < list.length; i++) {
            var inp = list[i];
            if (rhPasswordEyeNative(inp)) {
                /* the page brought its own eye — make sure ours is not also there */
                if (inp.getAttribute('data-rh-eye') === '1') rhPasswordEyeRemove(inp);
                continue;
            }
            rhPasswordEyeInstall(inp);
        }
    } catch (e) { }
}
function rhPasswordEyesBoot() {
    try {
        var st = document.createElement('style');
        st.textContent =
            '.rh-pw{position:relative;display:block;width:100%}' +
            '.rh-pw>input{padding-right:38px !important;box-sizing:border-box}' +
            '.rh-pw-eye{position:absolute;top:50%;right:8px;transform:translateY(-50%);' +
            'width:26px;height:26px;border:none;background:transparent;cursor:pointer;' +
            'color:#94a3b8;font-size:.82rem;display:flex;align-items:center;justify-content:center;' +
            'padding:0;border-radius:6px;line-height:1}' +
            '.rh-pw-eye:hover{color:#475569;background:rgba(148,163,184,.16)}';
        (document.head || document.documentElement).appendChild(st);
    } catch (e) { }
    /* Installing during parse is a race: the input is parsed before the page's own
       eye button is, so we could add a second eye that never goes away. Wait for a
       parsed DOM and re-sweep a few times to cover late markup + async renders. */
    try {
        var rs = String(document.readyState || '');
        if (rs === 'complete' || rs === 'interactive') rhPasswordEyes(document);
    } catch (e) { }
    try { document.addEventListener('DOMContentLoaded', function () { rhPasswordEyes(document); }); } catch (e) { }
    try { window.addEventListener('load', function () { rhPasswordEyes(document); }); } catch (e) { }
    try { setTimeout(function () { rhPasswordEyes(document); }, 300); } catch (e) { }
    try { setTimeout(function () { rhPasswordEyes(document); }, 1500); } catch (e) { }
    try {
        if (typeof MutationObserver !== 'undefined' && document.documentElement) {
            /* Throttled: an un-throttled sweep on every mutation ran a full document
               query dozens of times a second on the big settings pages. */
            var rhPwBusy = 0;
            var obs = new MutationObserver(function () {
                if (rhPwBusy) return;
                rhPwBusy = 1;
                setTimeout(function () { rhPwBusy = 0; rhPasswordEyes(document); }, 250);
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
        }
    } catch (e) { }
}
function prodImgSrc(v) {
    var s = String(v === undefined || v === null ? '' : v);
    if (!s) return '';
    if (s.indexOf('@img:') === 0) {
        var u = '';
        try { u = (typeof rhImgUrl === 'function') ? (rhImgUrl(s) || '') : ''; } catch (e) { u = ''; }
        /* a still-unresolved marker must never reach the DOM */
        return (u && u.indexOf('@img:') !== 0) ? u : '';
    }
    return s;
}
/* ==========================================================================
   LOGO — show it EXACTLY as the reseller uploaded it (2026-09-18 request)
   --------------------------------------------------------------------------
   No resizing, no recolouring, nothing added. Whatever image and whatever size
   the reseller uploads is what appears in the header and the footer.

   DO NOT bring back the near-white stripping that used to live here. It made
   the logo's white pixels transparent to kill a white background — but when the
   logo's own INK is white (which is exactly what a dark header needs) it deleted
   the logo itself. The user saw their white logo turn dark. The uploaded file is
   now used byte-for-byte.
   ========================================================================== */
function rhSetLogo(el, src, fallbackText) {
    if (!el) return;
    if (!src) {
        el.classList.remove('hasimg');
        el.innerHTML = fallbackText;
        return;
    }
    el.classList.add('hasimg');
    el.innerHTML = '<img src="' + src + '" alt="">';
}
/* 2026-09-17 — SPEED: fetch the spilled image bytes WITHOUT blocking the page.
   The boot's synchronous XHR now asks for `?noimg=1`, so the page paints from a few
   KB of data. The images arrive here, in the background, and once they are in the
   cache we fire 'rh-images-ready' so any page that shows product images can redraw.
   Runs once per load; harmless when there is no server or no images. */
/* 2026-09-17 — run `fn` when the image cache is usable.
   Images now arrive ASYNCHRONOUSLY (see rhLoadImagesAsync), so a page that renders
   product images once at load can draw placeholders that never resolve. Any page
   showing product images should wrap its renderer in this.
   It covers BOTH orders: if the images are already here it runs immediately, and if
   they are still in flight it waits for the event. Safe to call at any time. */
function onRhImagesReady(fn) {
    if (typeof fn !== 'function') return;
    var run = function () { try { fn(); } catch (e) { } };
    if (window.__rhImagesReady) { run(); return; }
    try { document.addEventListener('rh-images-ready', run); } catch (e) { }
}
function rhLoadImagesAsync() {
    if (!RH_STORE_ON) return;
    if (window.__rhImgAsyncStarted) return;
    window.__rhImgAsyncStarted = true;
    try {
        /* 2026-09-19 — ask the image door, not the whole store.
           /api/images returns the same `rh_img_*` bytes but carries its own ETag,
           so a new order no longer forces every phone to re-download every photo.
           SAFETY: if that route is missing (an older server, or static hosting),
           we silently fall back to the old /api/store call. The images then arrive
           exactly as they always did — this can never make a picture disappear. */
        fetch('/api/images', { method: 'GET' })
            .then(function (r) {
                if (!r || !r.ok) throw new Error('no image route');
                return r.json();
            })
            .catch(function () {
                return fetch('/api/store', { method: 'GET' }).then(function (r) { return r.json(); });
            })
            .then(function (j) {
                var data = (j && j.data) || {};
                var pending = [];
                for (var k in data) {
                    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
                    if (String(k).indexOf('rh_img_') !== 0) continue;
                    pending.push([String(k).slice('rh_img_'.length), data[k]]);
                }
                if (!pending.length) return;
                try { rhImgPutAll(pending, function () { }); } catch (e) { }
                /* rhImgPutAll fills _rhImgCache synchronously, so the tags can be
                   fixed and the pages told to redraw right away. */
                try { rhResolveImgTags(); } catch (e) { }
                try { window.__rhImagesReady = true; } catch (e) { }
                try { document.dispatchEvent(new Event('rh-images-ready')); } catch (e) { }
            })
            .catch(function () { });
    } catch (e) { }
}
function rhImgIsBig(s) { return typeof s === 'string' && s.length > RH_IMG_SPILL_MIN && s.indexOf('data:image/') === 0; }

/* BUG FIX — "the reseller's My Shop logo disappears on its own".
   The storefront header and footer render the saved logo straight into
   `<img src="...">`. If that logo is spilled to an `@img:` ref, the read path is
       rhImgUrl(ref)  -> _rhImgCache[id] || ''
       rhResolveDeep  -> rhImgIsRef(x) ? (rhImgUrl(x) || x) : x
   so until the IndexedDB cache has hydrated — and FOREVER if that store is
   blocked, cleared or its bytes are gone — the page falls back to the RAW ref and
   renders `<img src="@img:i...">`, a broken image that is indistinguishable from
   "the logo was deleted". Reproduced in rh-shoplogo.js.
   A shop logo is ONE image per shop, so keeping it inline costs very little and
   makes the logo impossible to lose. */
var RH_IMG_KEEP_INLINE = { shop_logo: 1, shopLogo: 1, logo: 1 };

/* Clone-and-spill: returns a NEW structure with big images replaced by refs.
   Never mutates the caller's object (so a failed localStorage write cannot leave
   the caller holding refs with no bytes behind them). */
function rhSpillClone(node, pending, depth) {
    if (depth > 10 || node === null || node === undefined) return node;
    if (typeof node === 'string') {
        if (!rhImgIsBig(node)) return node;
        var id = rhImgNewId();
        _rhImgCache[id] = node;                 /* available immediately this session */
        pending.push([id, node]);
        return RH_IMG_REF + id;
    }
    if (Object.prototype.toString.call(node) === '[object Array]') {
        var a = new Array(node.length);
        for (var i = 0; i < node.length; i++) a[i] = rhSpillClone(node[i], pending, depth + 1);
        return a;
    }
    if (typeof node === 'object') {
        var o = {};
        for (var k in node) {
            if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
            /* the shop logo stays inline — see RH_IMG_KEEP_INLINE above */
            o[k] = RH_IMG_KEEP_INLINE[k] ? node[k] : rhSpillClone(node[k], pending, depth + 1);
        }
        return o;
    }
    return node;
}
/* Resolve refs back to real image strings, in place (getData returns a fresh parse
   each call, so mutating that copy is safe and avoids a second allocation). */
function rhResolveDeep(node, depth) {
    if (depth > 10 || node === null || node === undefined) return node;
    if (typeof node === 'string') return rhImgIsRef(node) ? (rhImgUrl(node) || node) : node;
    if (Object.prototype.toString.call(node) === '[object Array]') {
        for (var i = 0; i < node.length; i++) node[i] = rhResolveDeep(node[i], depth + 1);
        return node;
    }
    if (typeof node === 'object') {
        for (var k in node) { if (Object.prototype.hasOwnProperty.call(node, k)) node[k] = rhResolveDeep(node[k], depth + 1); }
        return node;
    }
    return node;
}
/* One-time: move the images already sitting in localStorage into IndexedDB. */
function rhMigrateImagesToIdb(cb) {
    var moved = 0;
    try {
        if (localStorage.getItem(RH_IMG_MARK) === '1') { if (cb) cb(0); return; }
        if (_rhImgAvailable === false) { if (cb) cb(0); return; }
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('rh_') === 0) keys.push(k); }
        for (var j = 0; j < keys.length; j++) {
            var raw;
            try { raw = localStorage.getItem(keys[j]); } catch (e) { continue; }
            if (!raw || raw.indexOf('data:image/') === -1) continue;
            try {
                var v = JSON.parse(raw);
                var pending = [];
                var out = rhSpillClone(v, pending, 0);
                if (!pending.length) continue;
                var json2 = JSON.stringify(out);
                if (json2.length >= raw.length) continue;      /* no gain -> leave it */
                localStorage.setItem(keys[j], json2);
                for (var p = 0; p < pending.length; p++) rhImgPut(pending[p][0], pending[p][1]);
                moved += pending.length;
            } catch (e) { }
        }
        try { localStorage.setItem(RH_IMG_MARK, '1'); } catch (e) { }
    } catch (e) { }
    if (cb) cb(moved);
}
/* Fix every <img> (and inline background-image) that still holds a ref. */
/* ==========================================================================
   2026-09-17 — ONE-TIME IMAGE MIGRATION  (this request)
   --------------------------------------------------------------------------
   WHY. Images uploaded BEFORE the shared-image fix live only in this browser's
   IndexedDB, so every other device shows a purple placeholder. Products already
   on disk carry `@img:<id>` refs in rh_products, but nothing ever put the BYTES
   in the shared store.
   WHAT THIS DOES. Walks every product, finds every `@img:<id>` ref, and — for
   any image this browser DOES have locally — mirrors it to the store under
   `rh_img_<id>`. From then on every browser can render it.
   SAFE. It only READS products and only ADDS to the store. It never edits a
   product, never deletes an image, and does nothing when there is no shared
   store or nothing is missing.
   ========================================================================== */
function rhStoreMigrateImages() {
    if (!RH_STORE_ON) return;
    try {
        /* 2026-09-17 — read the RAW stored JSON, NOT getData().
           getData() hands back a hydrated copy whose image fields have already been
           run through rhImgUrl(), so `@img:xxx` markers arrive here as resolved data
           URLs and this migration can never recognise them. localStorage holds the
           untouched record, which is exactly what we need. */
        var prods = [];
        try { prods = JSON.parse(localStorage.getItem(DB_KEYS.PRODUCTS) || '[]') || []; } catch (e) { prods = []; }
        var seen = {}, ids = [];
        for (var i = 0; i < prods.length; i++) {
            var p = prods[i];
            if (!p) continue;
            /* Read the RAW stored values — NOT productImages(), which resolves refs
               through rhImgUrl() and therefore returns data URLs, hiding the very
               markers this migration needs to find. */
            var list = [];
            if (Object.prototype.toString.call(p.images) === '[object Array]') list = list.concat(p.images);
            if (Object.prototype.toString.call(p.imgs) === '[object Array]') list = list.concat(p.imgs);
            if (p.image) list = list.concat([p.image]);
            if (p.primaryImage) list = list.concat([p.primaryImage]);
            for (var j = 0; j < list.length; j++) {
                var ref = list[j];
                if (!rhImgIsRef(ref)) continue;
                var id = ref.slice(RH_IMG_REF.length);
                if (!id || seen[id]) continue;
                seen[id] = 1;
                ids.push(id);
            }
        }
        if (!ids.length) return;
        /* only push the ones this browser actually has */
        var push = [];
        for (var k = 0; k < ids.length; k++) {
            var url = _rhImgCache[ids[k]] || '';
            if (url) push.push([ids[k], url]);
        }
        if (!push.length) return;
        for (var m = 0; m < push.length; m++) {
            try { rhStorePushImg(push[m][0], push[m][1]); } catch (e) { }
        }
        try { window.__rhImgMigrated = push.length; } catch (e) { }
    } catch (e) { }
}

function rhResolveImgTags() {
    try {
        var imgs = document.querySelectorAll('img[src^="' + RH_IMG_REF + '"]');
        for (var i = 0; i < imgs.length; i++) {
            var u = rhImgUrl(imgs[i].getAttribute('src'));
            if (u) imgs[i].setAttribute('src', u);
        }
        var styled = document.querySelectorAll('[style*="' + RH_IMG_REF + '"]');
        for (var j = 0; j < styled.length; j++) {
            var st = styled[j].getAttribute('style') || '';
            if (st.indexOf(RH_IMG_REF) === -1) continue;
            styled[j].setAttribute('style', st.replace(/@img:[A-Za-z0-9]+/g, function (m) { return rhImgUrl(m) || m; }));
        }
        rhImgRetryOnce();
    } catch (e) { }
}
/* RECOVERY — a ref that is STILL unresolved after the store has loaded means the
   first load came back incomplete (a transaction that errored, or bytes written
   by another tab while this one was booting). One further load is attempted,
   guarded so it can never loop, and whatever it recovers is swapped into the DOM.
   A ref whose bytes are genuinely gone stays unresolved and the page falls back
   to the rhImgLost() note instead of a broken image. */
var _rhImgRetried = false;
function rhImgRetryOnce() {
    if (_rhImgRetried || !_rhImgReady) return;
    try { if (!document.querySelectorAll('img[src^="' + RH_IMG_REF + '"]').length) return; } catch (e) { return; }
    _rhImgRetried = true;
    try { rhImgLoadAll(function () { try { rhResolveImgTags(); } catch (e) { } }); } catch (e) { }
}
function rhImgStoreBoot() {
    rhImgLoadAll(function () {
        rhMigrateImagesToIdb(function () {
            rhResolveImgTags();
            /* 2026-09-17 — ONE-TIME IMAGE MIGRATION (this request).
               Runs on every boot, right after the image layer is ready: it pushes any
               image this browser holds but the shared store lacks, so products uploaded
               before the shared-image fix become visible on every other device.
               It lives HERE, not in rhImgRetryOnce() — that only runs when the page
               still has unresolved <img> tags and only ever once, so the migration
               would frequently never fire. */
            try { if (typeof rhStoreMigrateImages === 'function') rhStoreMigrateImages(); } catch (e) { }
            /* 2026-09-17 — tell the page the image cache is usable.
               prodImgSrc() returns '' while _rhImgCache is still empty, so a page that
               renders ONCE at init (my-shop-product.html does) draws its placeholder
               and never recovers — rhResolveImgTags() only fixes <img src="@img:...">,
               and by then the page holds a placeholder <div>, not an <img>.
               Any page that shows product images can listen for this and re-render. */
            /* A flag as well as the event: app.js runs BEFORE the page's own script,
               so a page that registers its listener later would miss the event
               entirely. The flag lets it check "am I already late?" on load. */
            try { window.__rhImagesReady = true; } catch (e) { }
            try { document.dispatchEvent(new Event('rh-images-ready')); } catch (e) { }
        });
    });
    /* 2026-09-17 — and pull the image bytes in the background, so the page never
       waits on them. This is what makes My Shop load fast. */
    try { rhLoadImagesAsync(); } catch (e) { }
    /* 2026-09-17 — put a show/hide eye on every password field, on every page. */
    try { rhPasswordEyesBoot(); } catch (e) { }
    /* Watch for images rendered later (the app re-renders lists constantly). */
    try {
        if (typeof MutationObserver !== 'undefined' && document.documentElement) {
            var obs = new MutationObserver(function () { rhResolveImgTags(); });
            obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] });
        }
        document.addEventListener('DOMContentLoaded', rhResolveImgTags);
        window.addEventListener('load', rhResolveImgTags);
    } catch (e) { }
}

function getData(key) {
    try {
        var raw = localStorage.getItem(key) || '[]';
        var v = JSON.parse(raw);
        /* only walk when a ref is actually present (cheap string check) */
        if (raw.indexOf(RH_IMG_REF) !== -1) v = rhResolveDeep(v, 0);
        return v;
    } catch (e) { return []; }
}
function getOne(key) {
    try {
        var raw = localStorage.getItem(key) || '{}';
        var v = JSON.parse(raw);
        if (raw.indexOf(RH_IMG_REF) !== -1) v = rhResolveDeep(v, 0);
        return v;
    } catch (e) { return {}; }
}
/* ==========================================================================
   localStorage PRESSURE MANAGEMENT
   --------------------------------------------------------------------------
   BUG FIX — "Order could not be saved — storage is full or unavailable."

   localStorage has a hard ~5-10 MB budget for the WHOLE origin. Once it is
   full, EVERY write throws QuotaExceededError — including a tiny one like a new
   order — so the shop simply stops taking orders. Two things made it fill up:

     1. rh_tracking and rh_notIFICATIONS had NO CAP. They grow with every order
        event and every notification, forever. (rh_activity was already capped
        at 100.)
     2. base64 images (product images, shop logos, hero images, banners) are by
        far the biggest payloads.

   So we do two things:
     · cap the unbounded history stores (they are history, not business records)
     · when a write still fails, reclaim space from the lowest-value history and
       retry ONCE — an order must never be refused while a 400-entry tracking log
       is sitting in the same budget.
   The payload itself is never silently dropped: if the retry also fails the
   caller still gets `false` and reports it honestly.
   ========================================================================== */
var _rhFreeing = false;
var RH_HISTORY_CAPS = [
    /* [key, max entries]  — ordered lowest-value first */
    [DB_KEYS.TRACKING, 150],
    [DB_KEYS.NOTIFICATIONS, 120],
    [DB_KEYS.ACTIVITY, 50],
    [DB_KEYS.TRANSACTIONS, 250],
    [DB_KEYS.REVIEWS, 150],
    [DB_KEYS.SUPPORT, 150]
];
var RH_MAP_CAPS = [
    /* [key, max conversations, max messages per conversation] */
    [DB_KEYS.SHOP_CHATS, 20, 50],
    [DB_KEYS.MESSAGES, 20, 50]
];
function rhStorageBytes(key) {
    try { var v = localStorage.getItem(key); return v ? (String(key).length + v.length) * 2 : 0; } catch (e) { return 0; }
}
function rhStorageTotal() {
    var t = 0;
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); t += rhStorageBytes(k); } } catch (e) { }
    return t;
}
function rhStorageReport() {
    var out = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); out.push({ key: k, bytes: rhStorageBytes(k) }); } } catch (e) { }
    out.sort(function (a, b) { return b.bytes - a.bytes; });
    return out;
}
/* Trim the lowest-value history so an essential write can land.
   `skipKey` is the key we are trying to write — never trim that one.
   Returns the number of bytes reclaimed (0 when there was nothing to trim). */
function rhFreeSpace(skipKey) {
    if (_rhFreeing) return 0;                    /* no recursion */
    _rhFreeing = true;
    var freed = 0;
    try {
        for (var i = 0; i < RH_HISTORY_CAPS.length; i++) {
            var key = RH_HISTORY_CAPS[i][0], max = RH_HISTORY_CAPS[i][1];
            if (key === skipKey) continue;
            try {
                var v = getData(key);
                if (Object.prototype.toString.call(v) !== '[object Array]' || v.length <= max) continue;
                var before = rhStorageBytes(key);
                setData(key, v.slice(-max));
                freed += Math.max(0, before - rhStorageBytes(key));
            } catch (e) { }
        }
        for (var m = 0; m < RH_MAP_CAPS.length; m++) {
            var mk = RH_MAP_CAPS[m][0], maxConv = RH_MAP_CAPS[m][1], maxMsgs = RH_MAP_CAPS[m][2];
            if (mk === skipKey) continue;
            try {
                var obj = getData(mk);
                if (!obj || typeof obj !== 'object' || Object.prototype.toString.call(obj) === '[object Array]') continue;
                var names = Object.keys(obj);
                if (names.length <= maxConv) {
                    var anyLong = false;
                    for (var n0 = 0; n0 < names.length; n0++) {
                        var c0 = obj[names[n0]];
                        var arr0 = (c0 && Object.prototype.toString.call(c0) === '[object Array]') ? c0 : (c0 && c0.messages);
                        if (Object.prototype.toString.call(arr0) === '[object Array]' && arr0.length > maxMsgs) { anyLong = true; break; }
                    }
                    if (!anyLong) continue;
                }
                var before2 = rhStorageBytes(mk);
                var out = {};
                var keep = names.slice(-maxConv);
                for (var n = 0; n < keep.length; n++) {
                    var conv = obj[keep[n]];
                    if (conv && Object.prototype.toString.call(conv) === '[object Array]') {
                        out[keep[n]] = conv.slice(-maxMsgs);
                    } else if (conv && typeof conv === 'object') {
                        var copy = {};
                        for (var f in conv) { if (Object.prototype.hasOwnProperty.call(conv, f)) copy[f] = conv[f]; }
                        if (Object.prototype.toString.call(copy.messages) === '[object Array]') copy.messages = copy.messages.slice(-maxMsgs);
                        out[keep[n]] = copy;
                    } else { out[keep[n]] = conv; }
                }
                setData(mk, out);
                freed += Math.max(0, before2 - rhStorageBytes(mk));
            } catch (e) { }
        }
    } catch (e) { }
    _rhFreeing = false;
    return freed;
}
/* Shared image downscaler (canvas) — used by the background compactor below and
   available to any page that needs one. */
function rhShrinkDataUrl(dataUrl, maxLen, quality, cb) {
    try {
        var img = new Image();
        img.onload = function () {
            try {
                var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
                if (!w || !h) { cb(dataUrl); return; }
                var scale = Math.min(1, maxLen / Math.max(w, h));
                if (scale >= 1) { cb(dataUrl); return; }
                var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
                var cv = document.createElement('canvas');
                cv.width = cw; cv.height = ch;
                var cx = cv.getContext('2d');
                if (!cx) { cb(dataUrl); return; }
                cx.drawImage(img, 0, 0, cw, ch);
                var isPng = /^data:image\/png/i.test(dataUrl);
                cb(isPng ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', quality));
            } catch (e) { cb(dataUrl); }
        };
        img.onerror = function () { cb(dataUrl); };
        img.src = dataUrl;
    } catch (e) { cb(dataUrl); }
}
/* Walk any parsed value and collect every base64 image string that is worth
   shrinking. Returns [{ owner, path, value }] where owner is the object/array
   that directly holds the string, so the caller can replace it in place. */
function rhCollectBigImages(node, out, depth) {
    if (!node || depth > 8) return out;
    if (Object.prototype.toString.call(node) === '[object Array]') {
        for (var i = 0; i < node.length; i++) {
            var v = node[i];
            if (typeof v === 'string') {
                if (/^data:image\//i.test(v) && v.length > RH_IMG_MIN_CHARS) out.push({ owner: node, key: i, value: v });
            } else rhCollectBigImages(v, out, depth + 1);
        }
        return out;
    }
    if (typeof node === 'object') {
        for (var k in node) {
            if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
            var val = node[k];
            if (typeof val === 'string') {
                if (/^data:image\//i.test(val) && val.length > RH_IMG_MIN_CHARS) out.push({ owner: node, key: k, value: val });
            } else rhCollectBigImages(val, out, depth + 1);
        }
    }
    return out;
}
var RH_IMG_TARGET = 900;        /* longest side, px, after compaction */
var RH_IMG_QUALITY = 0.62;
var RH_IMG_MIN_CHARS = 60000;   /* only touch images bigger than this (~60k base64 chars) */
var _rhCompacting = false;
var _rhCompactingSince = 0;
/* Downscale the biggest stored images so the budget stops being eaten by photos.
   Async, bounded, and it saves each key as it finishes. Safe to call repeatedly. */
function rhCompactStoredImages(done, maxImages) {
    /* A previous run must never wedge the compactor: if an image decode never
       calls back (a broken/corrupt data URL) the flag would stay true forever and
       block every later attempt. Release it after a generous timeout. */
    if (_rhCompacting && (Date.now() - _rhCompactingSince) > 20000) _rhCompacting = false;
    if (_rhCompacting) { if (done) done(0); return; }
    _rhCompacting = true;
    _rhCompactingSince = Date.now();
    var budget = maxImages || 12;
    var report = rhStorageReport();
    var jobs = [];
    for (var i = 0; i < report.length && jobs.length < 4; i++) {
        var k = report[i].key;
        var parsed;
        try { parsed = JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { continue; }
        if (!parsed) continue;
        var found = rhCollectBigImages(parsed, [], 0);
        if (found.length) jobs.push({ key: k, data: parsed, imgs: found });
    }
    if (!jobs.length) { _rhCompacting = false; if (done) done(0); return; }
    var changed = 0, idx = 0;
    var flat = [];
    for (var j = 0; j < jobs.length; j++) for (var m = 0; m < jobs[j].imgs.length; m++) flat.push({ job: jobs[j], img: jobs[j].imgs[m] });
    var finish = function () {
        for (var s = 0; s < jobs.length; s++) { if (jobs[s].dirty) setData(jobs[s].key, jobs[s].data); }
        _rhCompacting = false;
        if (done) done(changed);
    };
    (function next() {
        if (idx >= flat.length || changed >= budget) { finish(); return; }
        var it = flat[idx++];
        var settled = false;
        /* if the decode never reports back, skip this image and keep going */
        var guard = setTimeout(function () {
            if (settled) return;
            settled = true;
            next();
        }, 2500);
        rhShrinkDataUrl(it.img.value, RH_IMG_TARGET, RH_IMG_QUALITY, function (out) {
            if (settled) return;
            settled = true;
            try { clearTimeout(guard); } catch (e) { }
            if (out && out.length && out.length < it.img.value.length) {
                it.img.owner[it.img.key] = out;
                it.job.dirty = true;
                changed++;
            }
            next();
        });
    })();
}
function setData(key, data) {
    var json;
    try { json = JSON.stringify(data); } catch (e) { return false; }
    /* Move big base64 images out of localStorage and into IndexedDB, keeping only
       a tiny ref in the payload. A CLONE is used so that if the write below fails
       the caller's object is untouched (it would otherwise be left holding refs
       whose bytes were never persisted).

       BUG FIX — "the images sent to the admin never show up".
       The spill is DESTRUCTIVE: the bytes leave the payload and are expected to
       live in IndexedDB. It used to run UNCONDITIONALLY, so on an origin where
       IndexedDB is blocked (some browsers block it on file://) — or merely not
       open yet — the `@img:` ref was written while the bytes were thrown away.
       The image was then unrecoverable, and the admin saw a broken <img> that
       could not even be opened in the zoom overlay.
       Two guards now make the swap safe:
         1. spill ONLY when the store is CONFIRMED usable (_rhImgAvailable===true).
            Unknown or unavailable => the payload is written inline, exactly as it
            was before this feature existed. Bigger, but never lossy.
         2. keep the inline payload, and put it back if the IndexedDB write later
            fails or aborts, so the bytes are never left without a home. */
    var pending = [], inlineJson = json, spilledKey = null;
    if (json.indexOf('data:image/') !== -1 && _rhImgAvailable === true) {
        try {
            var spilled = rhSpillClone(data, pending, 0);
            var sj = JSON.stringify(spilled);
            if (pending.length && sj.length < json.length) { json = sj; spilledKey = key; }
            else pending = [];
        } catch (e) { pending = []; }
    }
    var ok = false;
    try { localStorage.setItem(key, json); ok = true; }
    catch (e) {
        /* Out of space. Reclaim from the lowest-value history and retry ONCE so a
           small essential write (an order) is never refused while a big history
           log sits in the same budget. */
        try {
            if (rhFreeSpace(key) > 0) {
                try { localStorage.setItem(key, json); ok = true; } catch (e2) { }
            }
        } catch (e3) { }
        if (!ok) {
            /* Still no room: history alone could not pay for it, so photos are the
               bulk. Kick off the (async) image compactor so the NEXT attempt
               succeeds, and report the failure honestly rather than pretending. */
            try { setTimeout(function () { try { rhCompactStoredImages(function () { }, 8); } catch (e4) { } }, 50); } catch (e5) { }
            return false;
        }
    }
    /* the payload is safely stored — persist the spilled image bytes, and if that
       cannot be done, put the inline payload back so nothing is ever lost */
    if (pending.length) {
        rhImgPutAll(pending, function () {
            if (spilledKey === null) return;
            try {
                var cur = localStorage.getItem(spilledKey);
                if (cur && cur.indexOf(RH_IMG_REF) !== -1) localStorage.setItem(spilledKey, inlineJson);
            } catch (e) { }
        });
    }
    /* 2026-09-16 — SHARED STORE. The write above is the local truth; mirror it to
       the server so every other device sees it. rhStorePush() is debounced and
       no-ops when there is no server, so this cannot slow down or break a save.
       It is deliberately placed AFTER the successful localStorage write, so we
       only ever publish data that really was stored. */
    try { rhStorePush(key); } catch (e) { }
    return true;
}

function getNextOrderId() {
    var orders = getData(DB_KEYS.ORDERS);
    var max = 0;
    for (var i = 0; i < orders.length; i++) {
        var parts = orders[i].id.split('-');
        var n = parseInt(parts[1]) || 0;
        if (n > max) max = n;
    }
    return 'ORD-' + String(max + 1).padStart(6, '0');
}
function getNextWithdrawId() {
    var ws = getData(DB_KEYS.WITHDRAWALS);
    var max = 0;
    for (var i = 0; i < ws.length; i++) {
        var parts = ws[i].id.split('-');
        var n = parseInt(parts[1]) || 0;
        if (n > max) max = n;
    }
    return 'WTH-' + String(max + 1).padStart(6, '0');
}
function getNextTicketId() {
    var ts = getData(DB_KEYS.SUPPORT);
    var max = 0;
    for (var i = 0; i < ts.length; i++) {
        var parts = ts[i].id.split('-');
        var n = parseInt(parts[1]) || 0;
        if (n > max) max = n;
    }
    return 'TKT-' + String(max + 1).padStart(6, '0');
}
function getNextResellerId() {
    var rs = getData(DB_KEYS.RESELLERS);
    var max = 0;
    for (var i = 0; i < rs.length; i++) { if (rs[i].id > max) max = rs[i].id; }
    return max + 1;
}

// Track online status (works for resellers AND suppliers)
function setOnline(userId, isOnline) {
    var online = getData(DB_KEYS.ONLINE);
    online[userId] = { online: isOnline, lastSeen: new Date().toISOString() };
    setData(DB_KEYS.ONLINE, online);
    var lists = [getData(DB_KEYS.RESELLERS), getData(DB_KEYS.SUPPLIERS)];
    for (var l = 0; l < lists.length; l++) {
        var changed = false;
        for (var i = 0; i < lists[l].length; i++) {
            if (lists[l][i].id === userId) { lists[l][i].isOnline = isOnline; lists[l][i].lastSeen = new Date().toISOString(); changed = true; break; }
        }
        if (changed) setData(l === 0 ? DB_KEYS.RESELLERS : DB_KEYS.SUPPLIERS, lists[l]);
    }
}

function isResellerOnline(userId) {
    var online = getData(DB_KEYS.ONLINE);
    if (!online[userId]) return false;
    var lastSeen = new Date(online[userId].lastSeen);
    var now = new Date();
    var diff = (now - lastSeen) / 1000; // seconds
    return diff < 300; // 5 minutes = online
}

// Generate next Supplier ID like SID-00102
function getNextSupplierSid() {
    var sups = getData(DB_KEYS.SUPPLIERS);
    var max = 100;
    for (var i = 0; i < sups.length; i++) {
        var n = parseInt(String(sups[i].sid || 'SID-00100').replace('SID-', '')) || 100;
        if (n > max) max = n;
    }
    return 'SID-' + String(max + 1).padStart(5, '0');
}
function getNextSupplierId() {
    var sups = getData(DB_KEYS.SUPPLIERS);
    var max = 5000;
    for (var i = 0; i < sups.length; i++) { if (sups[i].id > max) max = sups[i].id; }
    return max + 1;
}

function getLastSeenText(userId) {
    var online = getData(DB_KEYS.ONLINE);
    if (!online[userId]) return 'Never';
    var lastSeen = new Date(online[userId].lastSeen);
    var now = new Date();
    var diff = Math.floor((now - lastSeen) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + ' minutes ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' hours ago';
    return Math.floor(diff / 86400) + ' days ago';
}
/* Build the alphabetic part of a referral code from the business name.
   "Style Fashion" -> STYLEFASHION (<=12 chars) else first 6 chars -> STYLEF */
function referralCodeBase(name) {
    var s = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s) s = 'RESELLER';
    if (s.length > 12) s = s.substring(0, 6);
    return s;
}
/* (#23) Unique auto-generated code: Business Name + a 4-digit number.
   Two resellers with the SAME business name always get different codes. */
function generateReferralCode(name, excludeId) {
    var base = referralCodeBase(name);
    var list = getData(DB_KEYS.RESELLERS) || [];
    var used = {};
    for (var i = 0; i < list.length; i++) {
        if (excludeId && String(list[i].id) === String(excludeId)) continue;
        var c = resellerRefCode(list[i]);
        if (c) used[String(c).toUpperCase()] = true;
    }
    var code, n;
    for (var t = 0; t < 400; t++) {
        n = Math.floor(1000 + Math.random() * 9000);
        code = base + n;
        if (!used[code]) return code;
    }
    // deterministic fallback — guaranteed unique
    n = 1000;
    while (used[base + n] && n < 9999) n++;
    return base + n;
}

// Stylex is always the first admin/owner
function ensureStylexAccount() {
    var resellers = getData(DB_KEYS.RESELLERS);
    var found = false;
    for (var i = 0; i < resellers.length; i++) {
        if (resellers[i].id === 1 && resellers[i].isPermanent) { found = true; break; }
    }
    if (!found) {
        resellers.unshift(STYLEX_ACCOUNT);
        setData(DB_KEYS.RESELLERS, resellers);
    }
}

function getCurrentUser() {
    try {
        var userId = sessionStorage.getItem('user_id');
        var userType = sessionStorage.getItem('user_type');
        if (!userId) return null;
        if (userType === 'admin') return { id: 'admin', type: 'admin', name: 'Admin', balance: 0 };
        if (userType === 'supplier') {
            var sups = getData(DB_KEYS.SUPPLIERS);
            for (var s = 0; s < sups.length; s++) { if (sups[s].id === parseInt(userId)) { sups[s].type = 'supplier'; return sups[s]; } }
            return null;
        }
        var resellers = getData(DB_KEYS.RESELLERS);
        var id = parseInt(userId);
        for (var i = 0; i < resellers.length; i++) {
            if (resellers[i].id === id) return resellers[i];
        }
        return null;
    } catch (e) { return null; }
}
function setCurrentUser(userId, type) {
    sessionStorage.setItem('user_id', String(userId));
    sessionStorage.setItem('user_type', type);
}
function doLogout() {
    sessionStorage.clear();
    window.location.href = '../index.html';
}
/* Reseller logout (item 19): destroys the session and any remembered login,
   then sends the user to the reseller login page. */
function resellerLogout() {
    /* Every step is individually guarded: an exception in ANY cleanup step must
       never prevent the redirect, otherwise Logout looks like it "does nothing". */
    try {
        var rid = sessionStorage.getItem('user_id');
        if (rid && typeof setOnline === 'function') setOnline(parseInt(rid), false);
    } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}
    try { if (typeof clearPersistentSession === 'function') clearPersistentSession(); } catch (e) {}
    try { localStorage.removeItem('rh_remember_reseller'); } catch (e) {}
    try { localStorage.removeItem('rh_remember_supplier'); } catch (e) {}
    try {
        if (window.location.pathname.indexOf('/login.html') === -1) {
            window.location.replace('login.html');
        }
    } catch (e) { window.location.href = 'login.html'; }
}
/* Supplier logout: clears session + remembered login (item 20) */
function supplierLogout() {
    try { sessionStorage.clear(); } catch (e) {}
    clearPersistentSession();
    window.location.href = 'index.html';
}
function logActivity(type, message) {
    var activities = getData(DB_KEYS.ACTIVITY);
    activities.push({ id: Date.now(), type: type, message: message, date: new Date().toISOString() });
    if (activities.length > 100) activities = activities.slice(-100);
    setData(DB_KEYS.ACTIVITY, activities);
}
function addNotification(userId, type, message, persistent) {
    persistent = persistent || false;
    var notifs = getData(DB_KEYS.NOTIFICATIONS);
    notifs.push({ id: Date.now() + Math.random(), userId: userId, type: type, message: message, date: new Date().toISOString().split('T')[0], read: false, persistent: persistent });
    /* BUG FIX — this store had NO CAP either (see addTracking above). Keep the
       newest 300 notifications PLUS every persistent one, then hard-cap the
       persistent set at 200 so it can never grow without bound. */
    if (notifs.length > 300) {
        var keep = [], pers = [];
        for (var i = notifs.length - 1; i >= 0 && keep.length < 300; i--) {
            if (notifs[i] && notifs[i].persistent === true) { if (pers.length < 200) pers.push(notifs[i]); }
            else keep.push(notifs[i]);
        }
        notifs = pers.concat(keep.reverse());
    }
    setData(DB_KEYS.NOTIFICATIONS, notifs);
}
function addTransaction(resellerId, type, amount, note, source) {
    var tx = getData(DB_KEYS.TRANSACTIONS);
    tx.unshift({ id: 'TX' + Date.now() + Math.floor(Math.random() * 100), resellerId: resellerId, type: type, amount: amount, note: note || '', source: source || 'system', date: new Date().toISOString() });
    if (tx.length > 500) tx = tx.slice(0, 500);
    setData(DB_KEYS.TRANSACTIONS, tx);
}

/* ===========================================================================
   ADMIN TRANSACTION HISTORY — one derived ledger (this request, 2026-09-14)

   Every money movement in this app already lands somewhere, but in FIVE
   different shapes across two different wallet models:
     · rh_transactions        reseller credit / debit   (reseller wallet, STORED)
     · rh_withdrawals         reseller withdrawal       (money leaving)
     · supplier.adjustments[] admin add / deduct        (supplier wallet)
     · rh_payouts_<sid>       supplier payout request   (money leaving)
     · delivered ORDERS       supplier credit           (supplier wallet, DERIVED
                                                         from status, never stored)
   The feed is DERIVED from those stores rather than written a second time, so
   the history can never disagree with the balances it reports — the failure
   mode that makes a "transaction history" worse than useless. Adding a parallel
   write at every call site would drift the first time one site was missed.
   =========================================================================== */

/* Admin BUYING price of one order line. Mirrors the supplier wallet's own
   buyPriceOf() precedence EXACTLY — the product's cost wins, and only when the
   product row is missing does the line's own frozen snapshot apply. It
   deliberately never falls back to a selling price: that would show a credit
   the supplier never received. */
function productBuyPriceOf(pid, it) {
    var p = pid ? findProductById(pid) : null;
    if (p) return Number(p.cost) || Number(p.buy_price) || 0;
    if (it) return Number(it.buy_price) || Number(it.cost) || 0;
    return 0;
}
/* Supplier payout requests live in one localStorage key per supplier. */
function supplierPayoutStoreIds() {
    var out = [];
    try {
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf('rh_payouts_') === 0) {
                var sid = k.slice(11);
                if (sid && out.indexOf(sid) === -1) out.push(sid);
            }
        }
    } catch (e) {}
    return out;
}
function supplierPayoutsOf(sid) {
    try { return asArray(JSON.parse(localStorage.getItem('rh_payouts_' + sid) || '[]')); }
    catch (e) { return []; }
}
/* Human labels for the ledger's "type" column. */
var LEDGER_LABELS = {
    credit: 'Balance added',
    debit: 'Balance deducted',
    withdrawal: 'Withdrawal request',
    payout: 'Payout request',
    adjustment: 'Admin adjustment',
    order_delivery: 'Order delivered — buying price',
    refund: 'Refund',
    commission: 'Referral commission'
};
function ledgerLabelOf(type) {
    var k = String(type || '').toLowerCase();
    return LEDGER_LABELS[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Transaction');
}
/* The unified ledger. Newest first. Read-only — it writes nothing. */
function adminLedger() {
    var out = [], i, j, k;
    var resellers = asArray(getData(DB_KEYS.RESELLERS));
    var suppliers = asArray(getData(DB_KEYS.SUPPLIERS));
    function rName(id) {
        for (var a = 0; a < resellers.length; a++) {
            if (String(resellers[a].id) === String(id)) return resellers[a].businessName || resellers[a].name || ('Reseller #' + id);
        }
        return 'Reseller #' + id;
    }
    function sName(id) {
        for (var a = 0; a < suppliers.length; a++) {
            if (String(suppliers[a].id) === String(id)) return suppliers[a].shopName || suppliers[a].name || ('Supplier #' + id);
        }
        return 'Supplier #' + id;
    }
    function push(e) {
        /* 2026-09-20 — e.ts may now be supplied by the caller. A withdrawal row
           needs a stamp that survives being stored as a bare date (see below);
           every other row keeps deriving it from e.date exactly as before. */
        if (e.ts === undefined || e.ts === null || e.ts === '') e.ts = orderTimeMs({ date: e.date });
        e.amount = Number(e.amount) || 0;
        out.push(e);
    }
    /* 2026-09-20 — BUG FIX: a withdrawal was stored as a bare DATE ("2026-09-19"),
       so it sorted at midnight of its own day — BEFORE the order profits credited
       later that same day. The withdrawal-breakdown FIFO walk therefore never put
       those credits in its pool and reported far less than the amount withdrawn
       (a ৳900 withdrawal showed only ৳410 from one order, and the rest of the
       orders were missing from the list entirely).
       A date-only stamp is really "sometime during that day", so it is treated as
       the END of that day. Same-day earnings then land in the pool where they
       belong. Rows that already carry a clock time are left untouched. */
    function withdrawalStampMs(dateStr) {
        var t = orderTimeMs({ date: dateStr });
        if (!t) return t;
        var s = String(dateStr || '').trim();
        /* exactly YYYY-MM-DD and nothing else -> no clock time was stored */
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return t + 86399999;   /* 23:59:59.999 */
        return t;
    }

    /* 1. reseller wallet transactions */
    var tx = asArray(getData(DB_KEYS.TRANSACTIONS));
    for (i = 0; i < tx.length; i++) {
        var t = tx[i] || {};
        var tType = String(t.type || 'credit').toLowerCase();
        push({
            date: t.date, party: 'reseller', partyId: t.resellerId, partyName: rName(t.resellerId),
            type: tType, label: ledgerLabelOf(tType),
            direction: (tType === 'debit' || tType === 'withdraw' || tType === 'withdrawal') ? 'debit' : 'credit',
            amount: t.amount, status: '', note: String(t.note || ''), source: String(t.source || 'system'), ref: String(t.id || '')
        });
    }

    /* 2. reseller withdrawals */
    var wd = asArray(getData(DB_KEYS.WITHDRAWALS));
    for (i = 0; i < wd.length; i++) {
        var x = wd[i] || {};
        var xNote = [];
        if (x.method) xNote.push(String(x.method));
        if (x.account) xNote.push(String(x.account));
        if (x.note) xNote.push(String(x.note));
        push({
            date: x.date, party: 'reseller', partyId: x.resellerId,
            partyName: String(x.resellerName || '') || rName(x.resellerId),
            type: 'withdrawal', label: ledgerLabelOf('withdrawal'), direction: 'debit',
            amount: x.amount, status: String(x.status || ''), note: xNote.join(' · '), source: 'withdrawals', ref: String(x.id || ''),
            /* 2026-09-20 — a bare date is treated as the END of that day, so the
               earnings banked earlier the same day are inside this withdrawal's
               window instead of sorting after it (see withdrawalStampMs). */
            ts: withdrawalStampMs(x.date)
        });
    }

    /* 3. supplier balance adjustments made by an admin */
    for (i = 0; i < suppliers.length; i++) {
        var s = suppliers[i] || {};
        var adj = asArray(s.adjustments);
        for (j = 0; j < adj.length; j++) {
            var a = adj[j] || {}, amt = Number(a.amount) || 0;
            if (!amt) continue;
            push({
                date: a.date, party: 'supplier', partyId: s.id,
                partyName: String(s.shopName || s.name || ('Supplier #' + s.id)),
                type: 'adjustment', label: amt > 0 ? 'Admin added balance' : 'Admin deducted balance (fine)',
                direction: amt > 0 ? 'credit' : 'debit', amount: Math.abs(amt),
                status: '', note: String(a.note || ''), source: 'admin', ref: ''
            });
        }
    }

    /* 4. supplier payout requests */
    var sids = supplierPayoutStoreIds();
    for (i = 0; i < sids.length; i++) {
        var pays = supplierPayoutsOf(sids[i]);
        for (j = 0; j < pays.length; j++) {
            var p = pays[j] || {};
            var pNote = [];
            if (p.method) pNote.push(String(p.method));
            if (p.account) pNote.push(String(p.account));
            push({
                date: p.date, party: 'supplier', partyId: sids[i], partyName: sName(sids[i]),
                type: 'payout', label: ledgerLabelOf('payout'), direction: 'debit',
                amount: p.amount, status: String(p.status || ''), note: pNote.join(' · '), source: 'payouts', ref: String(p.id || '')
            });
        }
    }

    /* 5. supplier credit earned by a DELIVERED order (derived, per supplier) */
    var orders = asArray(getData(DB_KEYS.ORDERS));
    for (i = 0; i < orders.length; i++) {
        var o = orders[i] || {};
        if (String(o.status || '') !== 'delivered') continue;
        if (typeof orderSupplierGroups !== 'function') continue;
        var groups = orderSupplierGroups(o, 'admin', '');
        for (j = 0; j < groups.length; j++) {
            var g = groups[j];
            if (!g || g.kind !== 'supplier' || !g.items || !g.items.length) continue;
            var sum = 0;
            for (k = 0; k < g.items.length; k++) {
                var it = g.items[k] || {};
                sum += productBuyPriceOf(it.productId, it) * (Number(it.qty) || 1);
            }
            if (!sum) continue;
            push({
                date: o.date, party: 'supplier', partyId: g.ownerId,
                partyName: String(g.label || '') || sName(g.ownerId),
                type: 'order_delivery', label: ledgerLabelOf('order_delivery'), direction: 'credit',
                amount: sum, status: 'delivered', note: 'Order #' + o.id, source: 'orders', ref: String(o.id)
            });
        }
    }

    out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return out;
}
/* Filter the ledger. opts: { party:'all'|'reseller'|'supplier', direction:'all'|'credit'|'debit', q:'text', from, to } */
function ledgerFilter(entries, opts) {
    var list = asArray(entries), o = opts || {}, out = [];
    var q = String(o.q || '').trim().toLowerCase();
    var from = o.from ? orderTimeMs({ date: o.from }) : 0;
    var to = o.to ? orderTimeMs({ date: o.to }) : 0;
    for (var i = 0; i < list.length; i++) {
        var e = list[i] || {};
        if (o.party && o.party !== 'all' && e.party !== o.party) continue;
        if (o.direction && o.direction !== 'all' && e.direction !== o.direction) continue;
        if (o.type && o.type !== 'all' && e.type !== o.type) continue;
        if (from && (e.ts || 0) < from) continue;
        if (to && (e.ts || 0) > to) continue;
        if (q) {
            var hay = (String(e.partyName || '') + ' ' + String(e.label || '') + ' ' + String(e.note || '') + ' ' +
                       String(e.ref || '') + ' ' + String(e.type || '') + ' ' + String(e.status || '')).toLowerCase();
            if (hay.indexOf(q) === -1) continue;
        }
        out.push(e);
    }
    return out;
}
/* Totals for a filtered ledger. */
function ledgerSummary(entries) {
    var list = asArray(entries), t = { count: list.length, credit: 0, debit: 0, resellerCredit: 0, resellerDebit: 0, supplierCredit: 0, supplierDebit: 0 };
    for (var i = 0; i < list.length; i++) {
        var e = list[i] || {}, amt = Number(e.amount) || 0;
        if (e.direction === 'debit') {
            t.debit += amt;
            if (e.party === 'supplier') t.supplierDebit += amt; else t.resellerDebit += amt;
        } else {
            t.credit += amt;
            if (e.party === 'supplier') t.supplierCredit += amt; else t.resellerCredit += amt;
        }
    }
    return t;
}

/* ===========================================================================
   MODERATOR ROLE (this request, 2026-09-14)

   A moderator is a RESTRICTED administrator. What a moderator may NOT do:
     · create, edit or remove another moderator
     · delete a PRODUCT — they may set it Out of Stock instead
     · delete an ORDER   — never; there is no permission at all
     · move money directly: adding / deducting a balance becomes a REQUEST that
       only the real admin can approve or reject. Rejecting it changes nothing.
   Everything else in the admin panel is available to them.

   HONEST LIMITATION — this app is 100% client-side with no server, so every
   rule below is enforced in the browser. It reliably stops an honest moderator
   from doing the wrong thing through the UI, but it is NOT a security boundary
   against anyone who opens devtools and rewrites sessionStorage. Real
   enforcement needs a backend this prototype does not have.
   =========================================================================== */
function adminSessionRole() {
    try {
        var ut = sessionStorage.getItem('user_type');
        if (ut === 'admin' || ut === 'moderator') return ut;
    } catch (e) {}
    return '';
}
function isModerator() { return adminSessionRole() === 'moderator'; }
function isRealAdmin() { return adminSessionRole() === 'admin'; }

function moderators() { return asArray(getData(DB_KEYS.MODERATORS)); }
function findModeratorById(id) {
    var list = moderators();
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
}
/* Login match for the admin login page. An INACTIVE moderator cannot sign in. */
function findModeratorByLogin(email, password) {
    var e = String(email || '').trim().toLowerCase(), p = String(password || '');
    if (!e || !p) return null;
    var list = moderators();
    for (var i = 0; i < list.length; i++) {
        var m = list[i] || {};
        if (String(m.email || '').trim().toLowerCase() === e && String(m.password || '') === p) {
            return (m.active === false) ? null : m;
        }
    }
    return null;
}
/* Permission predicates — read these instead of comparing user_type by hand. */
function canDeleteOrders() { return !isModerator(); }
function canDeleteProducts() { return !isModerator(); }
function canManageModerators() { return !isModerator(); }
function canAdjustBalanceDirectly() { return !isModerator(); }
function currentAdminLabel() {
    if (isModerator()) {
        var m = findModeratorById(sessionStorage.getItem('user_id'));
        return (m && (m.name || m.email)) || 'Moderator';
    }
    return 'Admin';
}
/* Guard for an action a moderator must never perform. Returns TRUE when the
   action was blocked, so a caller can simply `if (blockIfModerator('...')) return;` */
function blockIfModerator(what) {
    if (!isModerator()) return false;
    try { showToast('Moderator এই কাজটি করতে পারে না — ' + what, 'error'); } catch (e) {}
    try { logActivity('moderator_blocked', 'Moderator blocked from: ' + what); } catch (e) {}
    return true;
}

/* ---------- moderator balance-change requests ---------- */
function modRequests() { return asArray(getData(DB_KEYS.MOD_REQUESTS)); }
function pendingModRequests() {
    var list = modRequests(), out = [];
    for (var i = 0; i < list.length; i++) if (String(list[i].status) === 'pending') out.push(list[i]);
    return out;
}
function pendingModRequestCount() { return pendingModRequests().length; }
function addModRequest(req) {
    var r = req || {}, list = modRequests();
    var rec = {
        id: 'MR' + Date.now() + Math.floor(Math.random() * 100),
        kind: r.kind || 'balance',
        party: r.party === 'supplier' ? 'supplier' : 'reseller',
        partyId: r.partyId,
        partyName: String(r.partyName || ''),
        sign: Number(r.sign) < 0 ? -1 : 1,
        amount: Number(r.amount) || 0,
        note: String(r.note || ''),
        status: 'pending',
        requestedBy: String(r.requestedBy || ''),
        requestedByName: String(r.requestedByName || ''),
        date: new Date().toISOString()
    };
    list.unshift(rec);
    if (list.length > 300) list = list.slice(0, 300);
    setData(DB_KEYS.MOD_REQUESTS, list);
    return rec;
}
function findModRequest(id) {
    var list = modRequests();
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
}
/* Write an APPROVED request onto the real balance. Never call this from a
   moderator's own session — only the approval path uses it. */
function applyModRequest(r) {
    var amt = Number(r.amount) || 0;
    if (!amt || amt < 1) return { ok: false, message: 'Invalid amount.' };
    var signed = amt * (Number(r.sign) < 0 ? -1 : 1);
    if (r.party === 'supplier') {
        var sups = asArray(getData(DB_KEYS.SUPPLIERS)), s = null;
        for (var i = 0; i < sups.length; i++) if (String(sups[i].id) === String(r.partyId)) { s = sups[i]; break; }
        if (!s) return { ok: false, message: 'Supplier not found.' };
        s.adjustments = asArray(s.adjustments).concat([{
            amount: signed, note: (r.note ? r.note + ' — ' : '') + 'approved moderator request',
            date: new Date().toISOString()
        }]);
        setData(DB_KEYS.SUPPLIERS, sups);
        try {
            addNotification(s.id, 'payout', (signed > 0 ? 'Admin আপনার balance-এ ' : 'Admin আপনার balance থেকে ') +
                formatCurrency(amt) + (signed > 0 ? ' যোগ করেছেন' : ' কেটে নিয়েছেন') +
                (r.note ? ' — কারণ: ' + r.note : ''), true);
        } catch (e) {}
        return { ok: true, message: 'Supplier balance updated.' };
    }
    var rs = asArray(getData(DB_KEYS.RESELLERS)), t = null;
    for (var j = 0; j < rs.length; j++) if (String(rs[j].id) === String(r.partyId)) { t = rs[j]; break; }
    if (!t) return { ok: false, message: 'Reseller not found.' };
    if (signed < 0 && amt > (Number(t.balance) || 0)) return { ok: false, message: 'Deduct amount is bigger than the current balance.' };
    t.balance = (Number(t.balance) || 0) + signed;
    setData(DB_KEYS.RESELLERS, rs);
    try { addTransaction(t.id, signed > 0 ? 'credit' : 'debit', amt, (r.note ? r.note + ' — ' : '') + 'approved moderator request', 'admin'); } catch (e) {}
    try {
        addNotification(t.id, 'balance', (signed > 0 ? 'আপনার একাউন্টে ' + formatCurrency(amt) + ' টাকা যোগ করা হয়েছে।'
            : 'আপনার একাউন্ট থেকে ' + formatCurrency(amt) + ' টাকা কাটা হয়েছে।') +
            (r.note ? ' কারণ: ' + r.note : '') + ' নতুন ব্যালেন্স: ' + formatCurrency(t.balance), true);
    } catch (e) {}
    return { ok: true, message: 'Reseller balance updated.' };
}
function approveModRequest(id) {
    var r = findModRequest(id);
    if (!r) return { ok: false, message: 'Request not found.' };
    if (String(r.status) !== 'pending') return { ok: false, message: 'This request was already handled.' };
    if (isModerator()) return { ok: false, message: 'Only the admin can approve requests.' };
    var applied = applyModRequest(r);
    if (!applied.ok) return applied;
    var list = modRequests();
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) { list[i].status = 'approved'; list[i].handledAt = new Date().toISOString(); break; }
    }
    setData(DB_KEYS.MOD_REQUESTS, list);
    try { logActivity('mod_request_approved', 'Approved ' + r.party + ' #' + r.partyId + ' ' + (Number(r.sign) < 0 ? '-' : '+') + (Number(r.amount) || 0)); } catch (e) {}
    return { ok: true, message: applied.message };
}
function rejectModRequest(id, reason) {
    var r = findModRequest(id);
    if (!r) return { ok: false, message: 'Request not found.' };
    if (String(r.status) !== 'pending') return { ok: false, message: 'This request was already handled.' };
    if (isModerator()) return { ok: false, message: 'Only the admin can reject requests.' };
    var list = modRequests();
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) {
            /* REJECTED changes NOTHING on any balance — the request is simply closed. */
            list[i].status = 'rejected';
            list[i].reason = String(reason || '');
            list[i].handledAt = new Date().toISOString();
            break;
        }
    }
    setData(DB_KEYS.MOD_REQUESTS, list);
    try { logActivity('mod_request_rejected', 'Rejected ' + r.party + ' #' + r.partyId + ' ' + (Number(r.amount) || 0)); } catch (e) {}
    return { ok: true, message: 'Request rejected — no balance was changed.' };
}
function addTracking(orderId, status, location, note) {
    var tracking = getData(DB_KEYS.TRACKING);
    tracking.push({ id: Date.now(), orderId: orderId, status: status, location: location, note: note, date: new Date().toLocaleString('en-GB') });
    /* BUG FIX — this store had NO CAP and grew with every order event, forever,
       until localStorage filled up and EVERY write (including a new order)
       started failing. Keep the newest 300 events; the per-order view reads the
       order's own entries, which are always the newest ones. */
    if (tracking.length > 300) tracking = tracking.slice(-300);
    setData(DB_KEYS.TRACKING, tracking);
}
/* Read the tracking timeline of ONE order (oldest first). Read-only — it never
   writes, so the customer-facing My Account can show progress safely. */
function orderTracking(orderId) {
    var all = asArray(getData(DB_KEYS.TRACKING)), out = [];
    for (var i = 0; i < all.length; i++) {
        if (all[i] && String(all[i].orderId) === String(orderId)) out.push(all[i]);
    }
    out.sort(function (a, b) { return (Number(a.id) || 0) - (Number(b.id) || 0); });
    return out;
}
/* ---------------------------------------------------------------------------
   SHARED SIDEBAR TOGGLE
   The mobile sidebar button / overlay on the admin, reseller and supplier
   panels call toggleSidebar(). Some pages define it locally, but several
   reseller pages (my-products, messages, offers, shop-categories,
   my-shop-orders, my-shop-settings, customer-messages) only load app.js and
   therefore threw "ReferenceError: toggleSidebar is not defined" on every tap.
   Defining it here once fixes them all; a page-local definition (which runs
   later) still takes precedence, and behaviour matches the admin panels.
   --------------------------------------------------------------------------- */
if (!window.toggleSidebar) {
    window.toggleSidebar = function (open) {
        var sb = document.querySelector('.sidebar') || document.getElementById('sidebar');
        if (!sb) return;
        if (open === undefined) open = !sb.classList.contains('open');
        sb.classList.toggle('open', open);
        var ov = document.getElementById('sideOverlay') || document.querySelector('.side-overlay');
        if (ov) ov.classList.toggle('show', open);
        document.body.classList.toggle('sb-open', !!open);
    };
}

/* ---------------------------------------------------------------------------
   SHARED MOBILE BOTTOM NAV — self-installing
   WHY THIS EXISTS (root cause of the "bottom nav disappeared" bug):
   eight reseller pages carried the whole .bottom-nav CSS block, the
   body{padding-bottom:86px} rule and the @media(max-width:768px){.bottom-nav{
   display:flex}} rule — but the <nav class="bottom-nav"> markup itself had been
   dropped when those pages were built by copying another page's <head> only.
   Nothing threw; the bar was simply never in the DOM, so it silently vanished.
   CSS said "show me", but there was nothing to show.

   Defining the bar once, at the data-layer, means a page can no longer lose it
   by accident. Rules:
   - Only for a signed-in panel user (reseller / admin / supplier). Public pages
     (index.html, shop.html, my-shop*.html) and login/register pages are skipped.
   - If the page already ships its own <nav class="bottom-nav"> it is left
     completely untouched — this only fills a hole.
   - menuToggle() is provided too, so the "Menu" button always opens the sidebar
     drawer even on pages that never defined it.
   --------------------------------------------------------------------------- */
window.menuToggle = window.menuToggle || function () {
    var sb = document.querySelector('.sidebar') || document.getElementById('sidebar') || document.getElementById('sb');
    if (!sb) return;
    var open = !sb.classList.contains('open');
    /* Panels that ship their own drawer helper (the supplier uses tog()) must win,
       otherwise their overlay and scroll-lock would drift out of sync. */
    if (typeof window.tog === 'function') { try { window.tog(open); return; } catch (e) {} }
    window.toggleSidebar(open);
};

/* CSS for the auto-installed bar. Kept here (not in 8 different <style> blocks)
   so the bar can never be styled-but-missing again. It is deliberately written
   to lose to a page's own .bottom-nav rules, and to leave the sidebar's own
   "hide the bar while the drawer is open" behaviour intact. */
(function rhBottomNavCss() {
    if (typeof document === 'undefined' || !document.createElement) return;
    if (document.getElementById('rh-auto-bnav-css')) return;
    var css = ''
      + '.bottom-nav.rh-auto-bnav{display:none;position:fixed;bottom:10px;left:12px;right:12px;z-index:400;'
      + 'align-items:stretch;background:rgba(255,255,255,.97);backdrop-filter:blur(14px);'
      + 'border:1px solid #e8ecf4;border-radius:18px;box-shadow:0 -4px 24px rgba(15,23,42,.14);'
      + 'padding:7px 6px calc(7px + env(safe-area-inset-bottom));'
      + 'transition:transform .28s cubic-bezier(.2,.8,.3,1),opacity .28s ease}'
      + '.bottom-nav.rh-auto-bnav a,.bottom-nav.rh-auto-bnav button{flex:1;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;gap:3px;padding:7px 2px;border:none;background:none;'
      + 'color:#7b879c;font-size:.62rem;font-weight:700;text-decoration:none;cursor:pointer;'
      + 'border-radius:12px;font-family:inherit;line-height:1.2}'
      + '.bottom-nav.rh-auto-bnav a i,.bottom-nav.rh-auto-bnav button i{font-size:1.18rem;line-height:1}'
      + '.bottom-nav.rh-auto-bnav a span,.bottom-nav.rh-auto-bnav button span{display:block}'
      + '.bottom-nav.rh-auto-bnav a.active{color:#4f46e5;background:#eef2ff}'
      + '.bottom-nav.rh-auto-bnav .bn-menu{color:#4f46e5;background:#eef2ff;border-radius:12px}'
      + 'body.has-bnav .bottom-nav.rh-auto-bnav{display:none}'
      + 'body.sb-open .bottom-nav.rh-auto-bnav{opacity:0;pointer-events:none;transform:translateY(150%)}'
      + '@media(max-width:768px){body.has-bnav{padding-bottom:86px}'
      + 'body.has-bnav .bottom-nav.rh-auto-bnav{display:flex}}'
      + '@media(min-width:769px){body.has-bnav{padding-bottom:0}'
      + 'body.has-bnav .bottom-nav.rh-auto-bnav{display:none}}';
    var st = document.createElement('style');
    st.id = 'rh-auto-bnav-css';
    st.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(st);
})();

function rhBottomNavItems(kind) {
    if (kind === 'admin') {
        return [
            { href: 'dashboard.html', icon: 'fa-home', label: 'Home' },
            { href: 'orders.html', icon: 'fa-shopping-cart', label: 'Orders' },
            { href: 'products.html', icon: 'fa-box', label: 'Products' },
            { href: 'messages.html', icon: 'fa-comments', label: 'Messages' },
            { href: 'settings.html', icon: 'fa-user', label: 'Profile' }
        ];
    }
    if (kind === 'supplier') {
        return [
            { href: 'dashboard.html', icon: 'fa-home', label: 'Home' },
            { href: 'dashboard.html#/orders', icon: 'fa-shopping-cart', label: 'Orders' },
            { href: 'dashboard.html#/products', icon: 'fa-box', label: 'Products' },
            { href: 'dashboard.html#/messages', icon: 'fa-comments', label: 'Messages' },
            { href: 'dashboard.html#/profile', icon: 'fa-user', label: 'Profile' }
        ];
    }
    return [
        { href: 'dashboard.html', icon: 'fa-home', label: 'Home' },
        { href: 'products.html', icon: 'fa-box', label: 'Products' },
        { href: 'order.html', icon: 'fa-cart-plus', label: 'Order' },
        { href: 'profile.html', icon: 'fa-user', label: 'Profile' }
    ];
}

function rhInstallBottomNav() {
    try {
        if (!document.body) return;
        /* never touch a page that already has the bar */
        if (document.querySelector('.bottom-nav')) return;

        var path = (location.pathname || '').replace(/\\/g, '/');
        var file = path.split('/').pop();
        /* Public / standalone pages must not get a panel nav.
           NOTE: do NOT blanket-skip anything starting with "my-shop" — the
           RESELLER panel owns my-shop-orders.html, my-shop-settings.html and
           friend, and those are exactly the pages that lost the bar. Only the
           customer-facing storefront pages (which live in reseller/ too, with
           no panel chrome) are skipped, and they are named explicitly. */
        var skip = [
            '', 'index.html', 'shop.html', 'login.html', 'register.html',
            'my-shop.html', 'my-shop-product.html', 'my-shop-checkout.html',
            'my-shop-account.html'
        ];
        if (skip.indexOf(file) !== -1) return;
        if (document.body.hasAttribute('data-no-bnav')) return;

        var kind = null;
        if (/\/admin\//.test(path)) kind = 'admin';
        else if (/\/supplier\//.test(path)) kind = 'supplier';
        else if (/\/reseller\//.test(path)) kind = 'reseller';
        if (!kind) return;

        /* a panel page is only valid for the matching signed-in user type */
        var uid = null, utype = null;
        try { uid = sessionStorage.getItem('user_id'); utype = sessionStorage.getItem('user_type'); } catch (e) {}
        if (!uid || utype !== kind) return;

        var items = rhBottomNavItems(kind);
        var nav = document.createElement('nav');
        nav.className = 'bottom-nav rh-auto-bnav';
        nav.setAttribute('data-rh-auto', '1');

        /* The "Menu" button only makes sense when the page actually has a drawer
           to open. Standalone pages (reseller/transactions.html) are part of the
           panel but ship without a sidebar, so they get the links only. */
        var hasDrawer = !!(document.querySelector('.sidebar') ||
                           document.getElementById('sidebar') ||
                           document.getElementById('sb'));

        var html = '';
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var on = (it.href.split('#')[0] === file) ? ' class="active"' : '';
            html += '<a href="' + it.href + '"' + on + '><i class="fas ' + it.icon + '"></i><span>' + it.label + '</span></a>';
            if (kind !== 'supplier' && hasDrawer && i === items.length - 3) {
                /* reseller + admin both get a Menu button in the middle-right slot */
                html += '<button type="button" class="bn-menu" onclick="menuToggle()"><i class="fas fa-bars"></i><span>Menu</span></button>';
            }
        }
        /* the supplier panel is a single-page app with its own drawer helper */
        if (kind === 'supplier' && hasDrawer) {
            html += '<button type="button" class="bn-menu" onclick="menuToggle()"><i class="fas fa-bars"></i><span>Menu</span></button>';
        }
        nav.innerHTML = html;
        document.body.appendChild(nav);

        /* the bar only becomes visible <=768px; on desktop it stays hidden */
        document.body.classList.add('has-bnav');
    } catch (e) { /* never let a cosmetic bar break the page */ }
}

/* --------------------------------------------------------------------------
   MY SHOP IN A NEW TAB  (2026-09-15)
   sessionStorage is PER-TAB. The reseller panel's "My Shop" link is a bare
   `my-shop.html`, so opening it in a new tab (ctrl-click / "Open in new tab")
   arrives with no session at all and the storefront renders "Shop not found".
   Fix: stamp the SIGNED-IN reseller's OWN id onto every plain My Shop link, so
   the new tab resolves the shop from the URL instead of from the session.
   The id is read from that reseller's own session, so this can never point at
   another reseller's shop — it is the same identity the same-tab click uses.
   -------------------------------------------------------------------------- */
function rhStampMyShopLinks() {
    try {
        var uid = sessionStorage.getItem('user_id');
        if (!uid) return;
        if (sessionStorage.getItem('user_type') !== 'reseller') return;
        var as = document.querySelectorAll('a[href]');
        for (var i = 0; i < as.length; i++) {
            var a = as[i];
            if (a.getAttribute('data-rh-stamped') === '1') continue;
            var h = a.getAttribute('href') || '';
            if (!h || h.charAt(0) === '#') continue;
            /* NEVER touch a link that already targets a specific shop.
               `my-shop.html?rid=5` is somebody ELSE's storefront — stamping it
               would silently point another reseller's shop link at MY shop,
               which is exactly the identity-hijack bug this fix must not cause.
               Only a bare, shop-less link is ours to complete. */
            if (h.indexOf('?') !== -1) continue;
            var base = h.split('#')[0];
            if (!/(^|\/)my-shop\.html$/.test(base)) continue;
            /* KEEP any #hash. `my-shop.html#pgrid` is the "jump to products"
               button on the product page — stamping must add ?rid=, not swallow
               the fragment it was navigating to. */
            var frag = h.indexOf('#') === -1 ? '' : h.slice(h.indexOf('#'));
            a.setAttribute('href', base + '?rid=' + encodeURIComponent(uid) + frag);
            a.setAttribute('data-rh-stamped', '1');
        }
    } catch (e) { /* never let a link rewrite break the page */ }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rhInstallBottomNav);
    document.addEventListener('DOMContentLoaded', rhStampMyShopLinks);
} else {
    rhInstallBottomNav();
    rhStampMyShopLinks();
}

function showToast(message, type) {
    type = type || 'success';
    var toast = document.getElementById('toast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'toast'; document.body.appendChild(toast); }
    var bg = type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#3b82f6';
    var icon = type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle';
    toast.style.cssText = 'position:fixed;top:25px;right:25px;padding:14px 22px;border-radius:10px;color:white;font-weight:500;z-index:99999;display:flex;align-items:center;gap:10px;font-family:Inter,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.2);max-width:380px;background:' + bg;
    toast.innerHTML = '<i class="fas fa-' + icon + '"></i> ' + message;
    setTimeout(function() { toast.style.display = 'none'; }, 3500);
    toast.style.display = 'flex';
}
function formatCurrency(amount) { return '\u09F3' + (amount || 0).toLocaleString('en-IN'); }
// Admin reseller-price rule: supplier price <৳1000 → +৳100, ৳1000–2000 → +৳150, above ৳2000 → +৳200
function adminPrice(cost) { cost = Number(cost) || 0; if (cost < 1000) return cost + 100; if (cost <= 2000) return cost + 150; return cost + 200; }
function adminPriceLabel(cost) { cost = Number(cost) || 0; return cost < 1000 ? '+৳100' : (cost <= 2000 ? '+৳150' : '+৳200'); }
function formatDate(dateStr) {
    if (!dateStr) return '-';
    try {
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return String(d.getDate()).padStart(2, '0') + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
    } catch (e) { return dateStr; }
}
function fileToBase64(file) {
    return new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onload = function() { resolve(reader.result); };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

initDB();
ensureStylexAccount();

// Settings migration: ensure Stylex supplier account exists
(function ensureStylexSupplier() {
    var sups = getData(DB_KEYS.SUPPLIERS);
    var found = false;
    for (var i = 0; i < sups.length; i++) { if (sups[i].email === 'stylexshopping@gmail.com' && sups[i].isSupplier) { found = true; break; } }
    if (!found) {
        sups.unshift({ id: 5000, name: "Stylex Shopping", shopName: "Stylex Official Store", sid: "SID-00100", email: "stylexshopping@gmail.com", password: "Stylexshopping@26", phone: "01997904792", address: "Dhaka, Bangladesh", shopDescription: "Stylex Shopping official supplier store - best quality products at best price", shopLogo: "", rating: 5.0, reviews: 12, status: "approved", joinDate: "2024-01-01", isSupplier: true, lastSeen: new Date().toISOString() });
        setData(DB_KEYS.SUPPLIERS, sups);
    }
})();

// One-time migration: Stylex supplier used to be seeded with the same id (5001) and
// sid (SID-00101) as the demo supplier — supplier login then resolved to the wrong account.
// Re-assign Stylex to a free id/SID without wiping any existing data.
(function fixStylexSupplierId() {
    try {
        var sups = getData(DB_KEYS.SUPPLIERS);
        var stylex = null, dup = false, i;
        for (i = 0; i < sups.length; i++) {
            if (sups[i].email === 'stylexshopping@gmail.com' && sups[i].isSupplier) stylex = sups[i];
        }
        if (!stylex) return;
        for (i = 0; i < sups.length; i++) {
            if (sups[i] !== stylex && String(sups[i].id) === String(stylex.id)) { dup = true; break; }
        }
        if (!dup) return;
        var used = {};
        for (i = 0; i < sups.length; i++) { if (sups[i] !== stylex) used[String(sups[i].id)] = true; }
        var nid = 5000;
        while (used[String(nid)]) nid--;
        stylex.id = nid;
        stylex.sid = 'SID-00100';
        setData(DB_KEYS.SUPPLIERS, sups);
    } catch (e) {}
})();

// Remove orders that reference deleted products (orphan cleanup)
/* BUG FIX — this used to DELETE a real order whenever no item's productId
   resolved to a product still in rh_products. That silently destroyed customer
   orders in two very ordinary situations:
     (a) the admin/reseller later deletes or re-uploads the product — the order
         is a historical business record and MUST survive its product;
     (b) an order whose `items` array is empty (a manually keyed order, or a
         legacy row that stored a single top-level productId) — `keep` stayed
         false and the whole order was thrown away.
   Symptom the user saw: "the order was created, the panel said success, then it
   is in NO order list and the counts never move." The order was being deleted on
   the very next page load, by this function.
   It must only drop records that are not orders at all. */
(function cleanOrphanOrders() {
    try {
        var orders = getData(DB_KEYS.ORDERS);
        if (Object.prototype.toString.call(orders) !== '[object Array]') return;
        var out = [];
        for (var j = 0; j < orders.length; j++) {
            var o = orders[j];
            if (!o || typeof o !== 'object') continue;                       /* not an order record */
            var id = (o.id !== undefined && o.id !== null) ? String(o.id).trim() : '';
            if (!id) continue;                                               /* no order id -> unusable */
            out.push(o);
        }
        if (out.length !== orders.length) setData(DB_KEYS.ORDERS, out);
    } catch (e) {}
})();

// Settings migration: add outsideCharge if missing (no full reset needed)
(function migrateSettings() {
    var s = getOne(DB_KEYS.SETTINGS);
    if (!s.outsideCharge) {
        s.outsideCharge = 180;
        setData(DB_KEYS.SETTINGS, s);
    }
    if (s.deliveryCharge === undefined) { s.deliveryCharge = 60; setData(DB_KEYS.SETTINGS, s); }
})();

/* ==========================================================================
   SHARED HELPERS  (additive - used by the 21 requested features)
   ========================================================================== */

/* ---------- HTML escape (XSS safe) ---------- */
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

/* ==========================================================================
   1. VARIANT VALIDATION  (shared "order creation level" guard)
   ========================================================================== */

// Does this product actually expose selectable variants?
// (the 'Free Size' fallback that getVariants() invents is NOT a real variant)
function productHasVariants(p) {
    if (!p) return false;
    if (p.variants && Array.isArray(p.variants) && p.variants.length) return true;
    if (p.sizes && (Array.isArray(p.sizes) ? p.sizes.length : String(p.sizes).trim().length)) return true;
    if (p.colors && (Array.isArray(p.colors) ? p.colors.length : String(p.colors).trim().length)) return true;
    return false;
}
// Collect the size / colour option lists for a product (same rules as the My Shop page)
function productVariantLists(p) {
    var s = [], c = [];
    if (!p) return { s: s, c: c };
    if (p.sizes) { s = typeof p.sizes === 'string' ? p.sizes.split(',').map(function (x) { return x.trim(); }).filter(Boolean) : p.sizes.slice(); }
    if (p.colors) { c = typeof p.colors === 'string' ? p.colors.split(',').map(function (x) { return x.trim(); }).filter(Boolean) : p.colors.slice(); }
    if (p.variants && Array.isArray(p.variants)) {
        for (var i = 0; i < p.variants.length; i++) {
            var v = p.variants[i];
            if (v.sizes) { String(v.sizes).split(',').map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (x) { if (s.indexOf(x) === -1) s.push(x); }); }
            if (v.size && s.indexOf(v.size) === -1) s.push(v.size);
            if (v.name && c.indexOf(v.name) === -1) c.push(v.name);
            if (v.color && c.indexOf(v.color) === -1) c.push(v.color);
        }
    }
    return { s: s, c: c };
}
/* Central guard. Returns { ok:true } or { ok:false, message:'...' }.
   Every order / add-to-cart / buy-now path must call this BEFORE creating anything. */
function validateVariantSelection(p, selSize, selColor) {
    if (!p) return { ok: false, message: 'Product not found.' };
    /* PART 24 — no size / no colour / no variants -> nothing is required */
    if (!productHasVariants(p)) return { ok: true };
    var lists = productVariantLists(p);
    /* PART 21, 22, 23, 25 — only require the axes the product actually has */
    if (lists.s.length && !selSize) return { ok: false, message: 'Please select a size.' };
    if (lists.c.length && !selColor) return { ok: false, message: 'Please select a color.' };
    if (lists.s.length && selSize && lists.s.indexOf(selSize) === -1) return { ok: false, message: 'Invalid variant selected.' };
    if (lists.c.length && selColor && lists.c.indexOf(selColor) === -1) return { ok: false, message: 'Invalid variant selected.' };
    /* PART 27, 28 — the exact selected variant must exist AND be in stock.
       Stock/price of a different variant must never be used for this order.
       Only enforced when the variant grid actually carries stock; otherwise the
       product-level stock is authoritative and a size/colour list alone must not
       block the order. */
    if (!productVariantsActive(p)) return { ok: true };
    var vs = productVariants(p);
    if (vs.length) {
        var found = false, inStock = false;
        for (var i = 0; i < vs.length; i++) {
            var v = vs[i] || {};
            if (selSize && String(v.size || '') !== String(selSize)) continue;
            if (selColor && String(v.color || v.name || '') !== String(selColor)) continue;
            found = true;
            if ((Number(v.stock) || 0) > 0) { inStock = true; break; }
        }
        if (!found) return { ok: false, message: 'Invalid variant selected.' };
        if (!inStock) return { ok: false, message: 'Out of Stock — এই variant এখন available নেই।' };
    }
    return { ok: true };
}
/* Same guard for an already-built cart/order item array (defence in depth for
   checkout & order.html which build items from several places). */
function validateOrderItems(items) {
    if (!items || !items.length) return { ok: false, message: 'Cart is empty.' };
    var products = getData(DB_KEYS.PRODUCTS);
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        var p = null;
        for (var j = 0; j < products.length; j++) { if (String(products[j].id) === String(it.productId)) { p = products[j]; break; } }
        if (!p) continue;                       // unknown product - leave to existing checks
        var chk = validateVariantSelection(p, it.size, it.color);
        if (!chk.ok) return { ok: false, message: (it.name || 'Product') + ': ' + chk.message };
        /* 2026-09-15 — STOCK GUARD.
           Nothing checked the ordered quantity against stock before, so a cart
           could ask for 50 of a product with 3 in stock and the order was
           ACCEPTED — the supplier then received an order they could never fulfil.
           The available figure comes from the existing variantStockFor() helper,
           so a variant product is judged on the exact size/colour chosen rather
           than the product total.
           Only enforced when the product actually tracks stock: a product with no
           stock field at all is left completely alone, exactly as before. */
        var tracksStock = productVariantsActive(p) ||
                          (p.stock !== undefined && p.stock !== null && p.stock !== '');
        if (tracksStock) {
            var avail = Number(variantStockFor(p, it.size, it.color)) || 0;
            var want = Number(it.qty);
            if (!isFinite(want)) want = Number(it.quantity);
            if (isFinite(want) && want > avail) {
                return {
                    ok: false,
                    message: (it.name || p.name || 'Product') + ': only ' + avail +
                             ' left in stock (you asked for ' + want + ').'
                };
            }
        }
    }
    return { ok: true };
}

/* ==========================================================================
   2. PERSISTENT SESSION  (Supplier "Remember Login")
   Stores only {id,type,expiry} + a signature. NEVER stores a password.
   ========================================================================== */
var RH_SESSION_KEY = 'rh_persistent_session';
var RH_SESSION_DAYS = 30;
function _rhHash(s) { var h = 5381; for (var i = 0; i < s.length; i++) { h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0; } return h.toString(36); }
function _rhSalt() { return (SITE_INFO && SITE_INFO.siteName ? SITE_INFO.siteName : 'rh') + '|persistent|v1'; }
function savePersistentSession(userId, type) {
    try {
        var raw = JSON.stringify({ id: userId, type: type, exp: Date.now() + RH_SESSION_DAYS * 86400000 });
        var token = btoa(unescape(encodeURIComponent(raw))) + '.' + _rhHash(raw + '|' + _rhSalt());
        localStorage.setItem(RH_SESSION_KEY, token);
        return true;
    } catch (e) { return false; }
}
function readPersistentSession() {
    try {
        var token = localStorage.getItem(RH_SESSION_KEY);
        if (!token) return null;
        var parts = token.split('.');
        if (parts.length !== 2) { localStorage.removeItem(RH_SESSION_KEY); return null; }
        var raw = decodeURIComponent(escape(atob(parts[0])));
        if (_rhHash(raw + '|' + _rhSalt()) !== parts[1]) { localStorage.removeItem(RH_SESSION_KEY); return null; }
        var o = JSON.parse(raw);
        if (!o || !o.exp || Date.now() > o.exp) { localStorage.removeItem(RH_SESSION_KEY); return null; }
        return o;
    } catch (e) { try { localStorage.removeItem(RH_SESSION_KEY); } catch (e2) {} return null; }
}
function clearPersistentSession() { try { localStorage.removeItem(RH_SESSION_KEY); } catch (e) {} }
/* Restore a remembered session into sessionStorage. Returns the user object or null. */
function restorePersistentSession(type) {
    var s = readPersistentSession();
    if (!s) return null;
    if (type && s.type !== type) return null;
    sessionStorage.setItem('user_id', String(s.id));
    sessionStorage.setItem('user_type', s.type);
    if (s.type === 'supplier') {
        var sups = getData(DB_KEYS.SUPPLIERS);
        for (var i = 0; i < sups.length; i++) { if (String(sups[i].id) === String(s.id)) { setOnline(sups[i].id, true); return sups[i]; } }
    }
    /* PART 43, 45 — resellers use the same signed persistent token */
    if (s.type === 'reseller') {
        var rs = getData(DB_KEYS.RESELLERS);
        for (var j = 0; j < rs.length; j++) {
            if (String(rs[j].id) !== String(s.id)) continue;
            if (rs[j].status === 'banned' || rs[j].status === 'rejected' || rs[j].status === 'pending') {
                clearPersistentSession();
                sessionStorage.clear();
                return null;
            }
            setOnline(rs[j].id, true);
            return rs[j];
        }
        clearPersistentSession();     /* remembered reseller no longer exists */
    }
    return null;
}

/* ==========================================================================
   3. PURE-JS ZIP  (no external library, works on mobile + desktop)
   ========================================================================== */
function crc32(buf) {
    if (!window.__rhCrc) {
        var t = [], n, k, c;
        for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); } t[n] = c >>> 0; }
        window.__rhCrc = t;
    }
    var tb = window.__rhCrc, crc = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) { crc = tb[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8); }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
/* files: [{ name:'a.jpg', data: Uint8Array }] -> Blob (zip, stored/uncompressed) */
function buildZipBlob(files) {
    var i, j, out = [], central = [], offset = 0;
    var now = new Date();
    var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    function u16(v) { return [v & 255, (v >> 8) & 255]; }
    function u32(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }
    function put(a, b) { for (var z = 0; z < b.length; z++) a.push(b[z]); }
    function nameBytes(nm) {
        nm = String(nm).replace(/[^\w.\-() ]+/g, '_');
        var b = []; for (var q = 0; q < nm.length; q++) { b.push(nm.charCodeAt(q) & 0xFF); } return b;
    }
    for (i = 0; i < files.length; i++) {
        var nb = nameBytes(files[i].name), data = files[i].data, crc = crc32(data);
        var lf = [];
        put(lf, u32(0x04034b50)); put(lf, u16(20)); put(lf, u16(0)); put(lf, u16(0));
        put(lf, u16(dosTime)); put(lf, u16(dosDate));
        put(lf, u32(crc)); put(lf, u32(data.length)); put(lf, u32(data.length));
        put(lf, u16(nb.length)); put(lf, u16(0));
        put(lf, nb); for (j = 0; j < data.length; j++) lf.push(data[j]);
        var cd = [];
        put(cd, u32(0x02014b50)); put(cd, u16(20)); put(cd, u16(20)); put(cd, u16(0)); put(cd, u16(0));
        put(cd, u16(dosTime)); put(cd, u16(dosDate));
        put(cd, u32(crc)); put(cd, u32(data.length)); put(cd, u32(data.length));
        put(cd, u16(nb.length)); put(cd, u16(0)); put(cd, u16(0)); put(cd, u16(0)); put(cd, u16(0));
        put(cd, u32(0)); put(cd, u32(offset)); put(cd, nb);
        central.push(cd); offset += lf.length; out.push(lf);
    }
    var cdStart = offset, cdSize = 0;
    for (i = 0; i < central.length; i++) { cdSize += central[i].length; out.push(central[i]); }
    var eocd = [];
    put(eocd, u32(0x06054b50)); put(eocd, u16(0)); put(eocd, u16(0));
    put(eocd, u16(files.length)); put(eocd, u16(files.length));
    put(eocd, u32(cdSize)); put(eocd, u32(cdStart)); put(eocd, u16(0));
    out.push(eocd);
    var total = 0; for (i = 0; i < out.length; i++) total += out[i].length;
    var all = new Uint8Array(total), pos = 0;
    for (i = 0; i < out.length; i++) { for (j = 0; j < out[i].length; j++) all[pos++] = out[i][j]; }
    return new Blob([all], { type: 'application/zip' });
}
function safeFileName(s) { return String(s || 'product').replace(/[^\w\-]+/g, '_').substring(0, 60); }
function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000);
}
function extFromDataUrl(d) {
    var m = /^data:image\/([a-zA-Z0-9.+-]+);base64,/.exec(String(d || ''));
    if (!m) return 'jpg';
    var e = m[1].toLowerCase();
    if (e === 'jpeg') return 'jpg';
    return e;
}
/* Download every image of a product as one ZIP. Returns a Promise. */
function downloadProductImages(p) {
    var imgs = productImages(p);
    if (!imgs.length) { showToast('এই প্রোডাক্টে কোনো ছবি নেই', 'warning'); return Promise.resolve(0); }
    var jobs = imgs.map(function (src, i) {
        return fetch(src).then(function (r) { return r.arrayBuffer(); }).then(function (b) {
            return { name: safeFileName(p.name || 'product') + '-' + (i + 1) + '.' + extFromDataUrl(src), data: new Uint8Array(b) };
        }).catch(function () { return null; });
    });
    return Promise.all(jobs).then(function (list) {
        var ok = list.filter(function (x) { return x && x.data && x.data.length; });
        if (!ok.length) { showToast('ছবি ডাউনলোড করা যায়নি', 'error'); return 0; }
        triggerDownload(buildZipBlob(ok), safeFileName(p.name || 'product') + '-images.zip');
        showToast(ok.length + ' টি ছবি ZIP হিসেবে ডাউনলোড হচ্ছে', 'success');
        return ok.length;
    });
}

/* Every image URL of a product (base64 data URLs or http URLs, plus legacy single image) */
function productImages(p) {
    var out = [], i;
    if (!p) return out;
    if (Array.isArray(p.images)) { for (i = 0; i < p.images.length; i++) { if (p.images[i]) out.push(p.images[i]); } }
    if (Array.isArray(p.imgs)) { for (i = 0; i < p.imgs.length; i++) { if (p.imgs[i]) out.push(p.imgs[i]); } }
    if (p.image) out.push(p.image);
    var seen = {}, res = [];
    for (i = 0; i < out.length; i++) { if (!seen[out[i]]) { seen[out[i]] = 1; res.push(out[i]); } }
    return res;
}

/* ==========================================================================
   4. CLIPBOARD
   ========================================================================== */
function copyToClipboard(text) {
    return new Promise(function (resolve) {
        var done = function (ok) { resolve(ok); };
        if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
        } else { done(fallbackCopy(text)); }
    });
}
function fallbackCopy(text) {
    try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, ta.value.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return !!ok;
    } catch (e) { return false; }
}
/* Full product details as plain text (used by the supplier Copy button) */
function productDetailsText(p) {
    if (!p) return '';
    var retail = p.customer_price || p.retailPrice || Math.round((Number(p.price) || 0) * 1.8);
    var L = [];
    L.push('Product Title: ' + (p.name || '-'));
    L.push('SKU: ' + (p.sku || '-'));
    /* category can be stored under several legacy keys — read them all */
    var subN = p.subCategory || p.subcategory || p.subSection || p.sub_category || '';
    var subSubN = p.subSubCategory || p.subsubCategory || p.subSub || p.sub_sub || '';
    L.push('Category: ' + (p.category || '-'));
    L.push('Subcategory: ' + (subN || '-'));
    L.push('Sub-subcategory: ' + (subSubN || '-'));
    var chainTxt = productCategoryChain(p);
    if (chainTxt) L.push('Category Path: ' + chainTxt);
    L.push('Supplier Price: ৳' + (p.cost !== undefined && p.cost !== null && p.cost !== '' ? p.cost : (p.buy_price || p.price || 0)));
    L.push('Reseller Price: ৳' + (p.price || 0));
    L.push('Customer Retail Price: ৳' + retail);
    L.push('Stock: ' + (p.stock || 0));
    if (p.status) L.push('Status: ' + p.status);
    if (p.readyToCampaign) L.push('Ready to Campaign: Yes');
    var v = productVariantLists(p);
    if (v.s.length) L.push('Sizes: ' + v.s.join(', '));
    if (v.c.length) L.push('Colors: ' + v.c.join(', '));
    if (p.variants && p.variants.length) {
        L.push('Variants:');
        for (var i = 0; i < p.variants.length; i++) {
            var vv = p.variants[i];
            L.push('  - ' + [vv.size || vv.name || '', vv.color || '', vv.price ? '৳' + vv.price : '', vv.stock !== undefined ? vv.stock + ' pcs' : ''].filter(Boolean).join(' | '));
        }
    }
    if (p.description) L.push(''); else L.push('');
    L.push('Description: ' + String(p.description || '-').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    return L.join('\n');
}

/* ==========================================================================
   5. CATEGORY  >  SUBCATEGORY  >  SUB-SUBCATEGORY  (3 level tree)
   Backwards compatible: old string arrays are normalised to objects.
   ========================================================================== */
/* getData() runs everything through JSON.parse, so an array stored as
   ["A","B"] comes back as {"0":"A","1":"B"} — a plain object, NOT an Array.
   That is why .length / .filter / .map on it silently break. Normalise a
   parsed value back to a real Array before any caller touches it. */
function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
        var out = [];
        for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) out.push(v[k]); }
        return out;
    }
    return [];
}
/* Return the usable name of a category entry, tolerating BOTH shapes:
   the plain string "Shirt" and the admin editor's { name:'Shirt', subSubs:[…] }. */
function catEntryName(v) {
    if (v && typeof v === 'object') return String(v.name || '').trim();
    return String(v === undefined || v === null ? '' : v).trim();
}

/* Always return an Array. Storage can hold a falsy/odd value from an old
   build; callers do getCategories().filter(...) / .length all over the app,
   so normalise here (read-only guarantee for callers) instead of letting a
   stray value crash a page. */
function getCategories() {
    return asArray(getData(DB_KEYS.CATEGORIES));
}
function saveCategories(list) { return setData(DB_KEYS.CATEGORIES, Array.isArray(list) ? list : []); }
/* IMPORTANT: getData() re-parses localStorage on every call, so all mutating
   helpers below must work on ONE array instance and save THAT array back.
   (Mutating a detached copy and then calling saveCategories(getCategories())
   silently throws the change away.) */
function findCategoryIn(list, name) {
    for (var i = 0; i < list.length; i++) { if (list[i] && list[i].name === name) return list[i]; }
    return null;
}
function findCategory(name) { return findCategoryIn(getCategories(), name); }
/* Normalise every category to { name, subs:[ { name, subs:[{name}], subSubs:[…] } ] }.
   NOTE: the app grew TWO sub-sub spellings over time —
     · the older admin editor wrote  subs[].subs[]
     · the newer tree/My Shop layer uses subs[].subSubs[]
   This normaliser must accept EITHER and keep BOTH in sync, otherwise running it
   silently wipes one of them (it used to erase the whole subSubs tree). It never
   deletes a name: whatever is found in one place is mirrored into the other. */
function ensureCategoryTree() {
    var list = getCategories(), ch = false, i, j, k;
    for (i = 0; i < list.length; i++) {
        if (!list[i]) continue;
        if (!Array.isArray(list[i].subs)) { list[i].subs = []; ch = true; }
        for (j = 0; j < list[i].subs.length; j++) {
            if (typeof list[i].subs[j] === 'string') { list[i].subs[j] = { name: list[i].subs[j], subs: [], subSubs: [] }; ch = true; }
            if (!list[i].subs[j].name) continue;
            if (!Array.isArray(list[i].subs[j].subs)) { list[i].subs[j].subs = []; ch = true; }
            if (!Array.isArray(list[i].subs[j].subSubs)) { list[i].subs[j].subSubs = []; ch = true; }
            /* keep the two spellings mirrored, oldest-first, without duplicates */
            for (k = 0; k < list[i].subs[j].subs.length; k++) {
                var legacy = list[i].subs[j].subs[k];
                if (typeof legacy === 'string') { list[i].subs[j].subs[k] = { name: legacy }; legacy = list[i].subs[j].subs[k]; ch = true; }
                var ln = (legacy && legacy.name) ? String(legacy.name) : '';
                if (!ln) continue;
                if (!mirrorHasName(list[i].subs[j].subSubs, ln)) { list[i].subs[j].subSubs.push(ln); ch = true; }
            }
            for (k = 0; k < list[i].subs[j].subSubs.length; k++) {
                var nv = catEntryName(list[i].subs[j].subSubs[k]);
                if (!nv) continue;
                if (!mirrorHasName(list[i].subs[j].subs, nv)) { list[i].subs[j].subs.push({ name: nv }); ch = true; }
            }
        }
    }
    if (ch) saveCategories(list);
    return list;
}
/* does a list already contain this name (either spelling)? */
function mirrorHasName(arr, name) {
    var want = String(name || '').trim().toLowerCase();
    for (var i = 0; i < asArray(arr).length; i++) {
        if (catEntryName(arr[i]).toLowerCase() === want) return true;
    }
    return false;
}
function subNameOf(s) { return (s && typeof s === 'object') ? s.name : s; }
function getSubList(catName) {
    var c = findCategory(catName); if (!c || !c.subs) return [];
    var o = []; for (var i = 0; i < c.subs.length; i++) { var n = subNameOf(c.subs[i]); if (n) o.push(n); } return o;
}
function getSubSubList(catName, sub) {
    var c = findCategory(catName); if (!c || !c.subs) return [];
    for (var i = 0; i < c.subs.length; i++) {
        if (subNameOf(c.subs[i]) === sub) {
            var arr = (c.subs[i] && c.subs[i].subs) || [], o = [];
            for (var j = 0; j < arr.length; j++) { var n = subNameOf(arr[j]); if (n) o.push(n); }
            return o;
        }
    }
    return [];
}
function addSubCategory(catName, subName) {
    var list = ensureCategoryTree();
    var c = findCategoryIn(list, catName); if (!c) return false;
    if (!Array.isArray(c.subs)) c.subs = [];
    for (var i = 0; i < c.subs.length; i++) { if (subNameOf(c.subs[i]) === subName) return false; }
    c.subs.push({ name: subName, subs: [] });
    saveCategories(list); return true;
}
function addSubSubCategory(catName, sub, subSubName) {
    var list = ensureCategoryTree();
    var c = findCategoryIn(list, catName); if (!c) return false;
    for (var i = 0; i < c.subs.length; i++) {
        if (subNameOf(c.subs[i]) === sub) {
            if (!c.subs[i].subs) c.subs[i].subs = [];
            for (var j = 0; j < c.subs[i].subs.length; j++) { if (subNameOf(c.subs[i].subs[j]) === subSubName) return false; }
            c.subs[i].subs.push({ name: subSubName });
            saveCategories(list); return true;
        }
    }
    return false;
}
function renameSubSubCategory(catName, sub, oldName, newName) {
    newName = String(newName || '').trim();
    if (!newName) return false;
    var list = ensureCategoryTree();
    var c = findCategoryIn(list, catName); if (!c) return false;
    for (var i = 0; i < c.subs.length; i++) {
        if (subNameOf(c.subs[i]) === sub && c.subs[i].subs) {
            for (var j = 0; j < c.subs[i].subs.length; j++) {
                if (subNameOf(c.subs[i].subs[j]) === oldName) { c.subs[i].subs[j].name = newName; saveCategories(list); return true; }
            }
        }
    }
    return false;
}
function deleteSubSubCategory(catName, sub, name) {
    var list = ensureCategoryTree();
    var c = findCategoryIn(list, catName); if (!c) return false;
    for (var i = 0; i < c.subs.length; i++) {
        if (subNameOf(c.subs[i]) === sub && c.subs[i].subs) {
            for (var j = 0; j < c.subs[i].subs.length; j++) {
                if (subNameOf(c.subs[i].subs[j]) === name) { c.subs[i].subs.splice(j, 1); saveCategories(list); return true; }
            }
        }
    }
    return false;
}
/* ---- create / rename / delete at every level (Admin Product upload UI) ---- */
function addCategory(name) {
    name = String(name || '').trim();
    if (!name) return false;
    var list = ensureCategoryTree();
    if (findCategoryIn(list, name)) return false;
    list.push({ id: 'cat_' + Date.now(), name: name, icon: 'fa-tag', image: '', subs: [], count: 0 });
    saveCategories(list);
    return true;
}
function renameCategory(oldName, newName) {
    newName = String(newName || '').trim();
    if (!newName) return false;
    var list = ensureCategoryTree();
    if (oldName !== newName && findCategoryIn(list, newName)) return false;
    var c = findCategoryIn(list, oldName);
    if (!c) return false;
    c.name = newName;
    saveCategories(list);
    return true;
}
function deleteCategory(name) {
    ensureCategoryTree();
    var list = getCategories(), next = [], found = false;
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].name === name) { found = true; continue; }
        next.push(list[i]);
    }
    if (!found) return false;
    saveCategories(next);
    return true;
}
function renameSubCategory(catName, oldName, newName) {
    newName = String(newName || '').trim();
    if (!newName) return false;
    var list = ensureCategoryTree();
    var c = findCategoryIn(list, catName);
    if (!c || !c.subs) return false;
    for (var i = 0; i < c.subs.length; i++) {
        if (subNameOf(c.subs[i]) === oldName) {
            if (oldName !== newName) {
                for (var j = 0; j < c.subs.length; j++) { if (j !== i && subNameOf(c.subs[j]) === newName) return false; }
            }
            c.subs[i].name = newName;
            saveCategories(list);
            return true;
        }
    }
    return false;
}
function deleteSubCategory(catName, name) {
    var list = ensureCategoryTree();
    var c = findCategoryIn(list, catName);
    if (!c || !c.subs) return false;
    var next = [], found = false;
    for (var i = 0; i < c.subs.length; i++) {
        if (subNameOf(c.subs[i]) === name) { found = true; continue; }
        next.push(c.subs[i]);
    }
    if (!found) return false;
    c.subs = next;
    saveCategories(list);
    return true;
}
/* "Category › Subcategory › Sub-subcategory" — used by admin/reseller product lists */
function productCategoryChain(p) {
    if (!p) return '';
    var parts = [];
    var c = p.category || p.cat || '';
    if (c) parts.push(String(c));
    var s = p.subSection || p.sub_category || p.subcategory || '';
    if (s) parts.push(String(s));
    var ss = p.subSub || p.sub_sub || p.subSubCategory || '';
    if (ss) parts.push(String(ss));
    return parts.join(' › ');
}
// seed the 3-level tree with the documented example (Women > Burqa > Abaya/Hijab)
// Only ever ADDS the example when that branch is still empty — it must never
// create a blank category record nor overwrite the seeded hierarchy.
(function seedCategoryTree() {
    try {
        var list = ensureCategoryTree();
        var c = findCategoryIn(list, 'Women Fashion') || findCategoryIn(list, "Women's Fashion");
        if (c) {
            var hasBurqa = false;
            for (var i = 0; i < c.subs.length; i++) {
                if (String(catEntryName(c.subs[i])) === 'Burqa') { hasBurqa = true; break; }
            }
            if (!hasBurqa) {
                c.subs.push({ name: 'Burqa', subs: [{ name: 'Abaya' }, { name: 'Hijab' }], subSubs: ['Abaya', 'Hijab'] });
                saveCategories(list);
            }
        }
    } catch (e) {}
})();

/* ==========================================================================
   6. SALES HELPERS (Top Sale / Ready to Campaign / New Arrival / Out of Stock)
   ========================================================================== */
// Orders that count as a real sale (cancelled / returned / failed must not count)
function isValidSale(o) {
    if (!o) return false;
    var s = String(o.status || '').toLowerCase();
    return s !== 'cancelled' && s !== 'canceled' && s !== 'returned' && s !== 'rejected' && s !== 'failed';
}
// total units sold per productId
function salesCountByProduct() {
    var orders = getData(DB_KEYS.ORDERS), map = {}, i, j;
    for (i = 0; i < orders.length; i++) {
        if (!isValidSale(orders[i])) continue;
        var o = orders[i];
        if (o.items && o.items.length) {
            for (j = 0; j < o.items.length; j++) {
                var it = o.items[j] || {};
                var k = String(it.productId);
                if (!k || k === 'undefined') continue;
                map[k] = (map[k] || 0) + (Number(it.qty) || 0);
            }
        } else if (o.productId !== undefined && o.productId !== null) {
            var k2 = String(o.productId);
            map[k2] = (map[k2] || 0) + (Number(o.qty) || 1);
        }
    }
    return map;
}
function productCreatedTime(p) {
    var t = p.createdAt || p.created_at || p.date || p.joinDate || p.uploadedAt;
    var d = t ? new Date(t) : null;
    return (d && !isNaN(d.getTime())) ? d.getTime() : 0;
}
/* Variant-aware availability. A product is Out of Stock when:
   - its status flag says so, or
   - the variant grid carries stock and EVERY variant is 0, or
   - there is no variant grid and stock <= 0.
   A product with at least one variant in stock is NOT out of stock. */
function isOutOfStock(p) {
    if (!p) return true;
    var st = String(p.status || p.stock_status || '').toLowerCase();
    if (st === 'out of stock' || st === 'outofstock' || p.out_of_stock === true) return true;
    if (productVariantsActive(p)) {
        var vs = productVariants(p);
        for (var i = 0; i < vs.length; i++) { if ((Number(vs[i].stock) || 0) > 0) return false; }
        return true;
    }
    return (Number(p.stock) || 0) <= 0;
}
function isReadyToCampaign(p) { return !!(p && (p.readyToCampaign || p.ready_to_campaign)); }

/* ==========================================================================
   7. REUSABLE SINGLE-IMAGE UPLOAD WIDGET
   Used by: admin Add Reseller (NID front / NID back),
            admin Add Supplier (Trade License).
   Returns { getValue, setValue, clear } so pages can read the data URL on submit.
   ========================================================================== */
function createImageUploader(container, opts) {
    if (!container) return null;
    opts = opts || {};
    var label = opts.label || 'Photo';
    var maxMB = opts.maxMB || 2;
    var value = opts.value || '';
    var box = document.createElement('div');
    box.style.cssText = 'border:2px dashed #cbd5e1;border-radius:12px;padding:10px;text-align:center;cursor:pointer;background:#f8fafc;transition:.15s;';
    var file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.style.display = 'none';
    /* mount the widget INSIDE the container the caller passed in */
    container.innerHTML = '';
    container.appendChild(box);
    function draw() {
        box.style.borderStyle = value ? 'solid' : 'dashed';
        box.style.borderColor = value ? '#10b981' : '#cbd5e1';
        if (value) {
            box.innerHTML = '<img src="' + value + '" alt="' + esc(label) + '" style="width:100%;height:110px;object-fit:contain;border-radius:8px;background:#fff;display:block;">' +
                '<div style="font-size:.68rem;color:#64748b;margin-top:6px;font-weight:700;">' + esc(label) + ' \u2713</div>' +
                '<button type="button" class="iu-rm" style="margin-top:6px;padding:4px 10px;border:none;border-radius:6px;background:#fee2e2;color:#b91c1c;font-size:.68rem;font-weight:800;cursor:pointer;">Remove</button>';
            var rm = box.querySelector('.iu-rm');
            if (rm) rm.onclick = function (e) { e.stopPropagation(); value = ''; draw(); if (opts.onChange) opts.onChange(''); };
        } else {
            box.innerHTML = '<div style="padding:14px 6px;"><i class="fas fa-cloud-upload-alt" style="font-size:1.3rem;color:#94a3b8;"></i>' +
                '<div style="font-size:.72rem;font-weight:800;color:#475569;margin-top:5px;">' + esc(label) + '</div>' +
                '<div style="font-size:.63rem;color:#94a3b8;margin-top:2px;">Click to upload (max ' + maxMB + 'MB)</div></div>';
        }
        box.appendChild(file);
    }
    box.onclick = function () { file.click(); };
    file.onchange = function () {
        var f = file.files && file.files[0];
        if (!f) return;
        if (f.size > maxMB * 1048576) { showToast('Image too large! Max ' + maxMB + 'MB.', 'error'); file.value = ''; return; }
        var r = new FileReader();
        r.onload = function () { value = String(r.result); draw(); if (opts.onChange) opts.onChange(value); file.value = ''; };
        r.readAsDataURL(f);
    };
    draw();
    return {
        getValue: function () { return value; },
        setValue: function (v) { value = v || ''; draw(); },
        clear: function () { value = ''; draw(); }
    };
}
/* Convenience: read a data URL straight off a plain <input type="file"> */
function readImageFile(fileInput, cb, maxMB) {
    if (!fileInput || !fileInput.files || !fileInput.files[0]) { cb(''); return; }
    maxMB = maxMB || 2;
    var f = fileInput.files[0];
    if (f.size > maxMB * 1048576) { showToast('Image too large! Max ' + maxMB + 'MB.', 'error'); fileInput.value = ''; cb(''); return; }
    var r = new FileReader();
    r.onload = function () { cb(String(r.result)); fileInput.value = ''; };
    r.readAsDataURL(f);
}

/* ==========================================================================
   REFERRAL SYSTEM  (#22 - #48)
   --------------------------------------------------------------------------
   Tier 1 : ৳5  per delivered order of a referred reseller.
   Tier 2 : ৳10 per delivered order — unlocked when the referrer has
            >= 50 referred resellers that EACH have >= 5 delivered orders.
   Tier 2 is NOT retroactive: the amount + tier are frozen onto every
   commission row at the moment it is created, so commissions earned while
   on Tier 1 stay ৳5 forever (#27).
   ========================================================================== */

/* ---------- storage helpers (#45) ---------- */
function getReferralRelations() {
    var r = getData(DB_KEYS.REFERRAL_RELATIONS);
    return Object.prototype.toString.call(r) === '[object Array]' ? r : [];
}
function saveReferralRelations(list) { setData(DB_KEYS.REFERRAL_RELATIONS, list); }
function getReferralCommissions() {
    var c = getData(DB_KEYS.REFERRAL_COMMISSIONS);
    return Object.prototype.toString.call(c) === '[object Array]' ? c : [];
}
function saveReferralCommissions(list) { setData(DB_KEYS.REFERRAL_COMMISSIONS, list); }

/* ---------- field accessors (accept camelCase + snake_case) ---------- */
function resellerRefCode(r) {
    if (!r) return '';
    return String(r.referralCode || r.referral_code || '').trim();
}
function resellerReferredBy(r) {
    if (!r) return null;
    var v = (r.referredBy !== undefined && r.referredBy !== null) ? r.referredBy : r.referred_by;
    if (v === undefined || v === null || v === '') return null;
    var n = parseInt(v);
    return isNaN(n) ? null : n;
}
function setResellerRefCode(r, code) { if (r) { r.referralCode = code; r.referral_code = code; } }
function setResellerReferredBy(r, id) { if (r) { r.referredBy = id; r.referred_by = id; } }

/* ---------- backfill: give every reseller a unique code (#23) ---------- */
function ensureReferralCodes() {
    var list = getData(DB_KEYS.RESELLERS) || [];
    var changed = false;
    var seen = {};
    for (var i = 0; i < list.length; i++) {
        var c = resellerRefCode(list[i]);
        if (!c || seen[c.toUpperCase()]) {
            setResellerRefCode(list[i], generateReferralCode(list[i].businessName || list[i].name, list[i].id));
            changed = true;
        }
        seen[resellerRefCode(list[i]).toUpperCase()] = true;
    }
    if (changed) setData(DB_KEYS.RESELLERS, list);
    return changed;
}

/* THIS reseller's OWN code — never somebody else's.
   `ensureReferralCodes()` only repairs a code that is EMPTY or an exact
   duplicate, and it writes the repair with setData(), which returns false when
   the browser's storage is full. Until that repair is persisted every page
   keeps reading the stale value, so a reseller could be shown the OWNER's code
   (STYLEX01) instead of one generated from their own business name.
   This resolver is the single place the panel asks "what is my code?": it
   verifies the stored code really belongs to this reseller, regenerates it from
   their own business name / personal name when it does not, and persists it.
   Accepts a reseller record or a reseller id. */
function resellerOwnRefCode(ref) {
    var list = getData(DB_KEYS.RESELLERS) || [];
    var rid = (ref && typeof ref === 'object') ? ref.id : ref;
    var rec = null, i;
    for (i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(rid)) { rec = list[i]; break; }
    }
    /* Unknown record — never invent an identity for it. */
    if (!rec) return resellerRefCode(ref);
    var mine = String(resellerRefCode(rec) || '').toUpperCase();
    var clash = !mine;
    if (!clash) {
        for (i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(rec.id)) continue;
            if (String(resellerRefCode(list[i]) || '').toUpperCase() === mine) { clash = true; break; }
        }
    }
    if (clash) {
        var code = generateReferralCode(rec.businessName || rec.name, rec.id);
        setResellerRefCode(rec, code);
        try { setData(DB_KEYS.RESELLERS, list); } catch (e) {}
        if (ref && typeof ref === 'object') setResellerRefCode(ref, code);
    }
    return resellerRefCode(rec);
}

/* ---------- lookup ---------- */
function findResellerByCode(code) {
    code = String(code || '').trim().toUpperCase();
    if (!code) return null;
    var list = getData(DB_KEYS.RESELLERS) || [];
    for (var i = 0; i < list.length; i++) {
        if (resellerRefCode(list[i]).toUpperCase() === code) return list[i];
    }
    return null;
}
function findResellerById(id) {
    var list = getData(DB_KEYS.RESELLERS) || [];
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
}

/* Part 2 — ONE canonical "business name" resolver for every My Shop surface.
   The storefront pages each carried their own hand-copied fallback chain, and
   two of them had drifted: `my-shop.html` and `my-shop-checkout.html` omitted
   `business_name`, so a record that stores the snake_case field would fall all
   the way through to the OWNER'S PERSONAL NAME (`name`) and the header would
   read "Rahim" / "Zahid" instead of the shop name.
   Every alias is checked here, in business-first order, and the personal name is
   only ever used when the record genuinely has no business name at all.
   Accepts either a reseller id or a reseller record. */
function resellerBusinessName(ref) {
    var r = (ref && typeof ref === 'object') ? ref
          : (ref === undefined || ref === null || ref === '') ? null : findResellerById(ref);
    if (!r) return 'My Shop';
    return String(
        r.shop_name || r.businessName || r.business || r.shopName ||
        r.business_name || r.companyName || r.shop_business || r.name || ''
    ).trim() || 'My Shop';
}

/* (#24, #44) Validate a code typed during registration.
   ctx may carry {id, phone, email} of the person registering. */
function validateReferralCode(code, ctx) {
    code = String(code || '').trim();
    if (!code) return { ok: true, none: true, message: '' };
    var owner = findResellerByCode(code);
    if (!owner) return { ok: false, message: 'Invalid referral code' };
    if (owner.status === 'banned') return { ok: false, message: 'Invalid referral code' };
    ctx = ctx || {};
    if (ctx.id !== undefined && ctx.id !== null && String(owner.id) === String(ctx.id)) {
        return { ok: false, message: 'আপনি নিজের Referral Code ব্যবহার করতে পারবেন না (Self-referral allowed নয়)' };
    }
    if (ctx.phone && owner.phone && String(owner.phone) === String(ctx.phone)) {
        return { ok: false, message: 'আপনি নিজের Referral Code ব্যবহার করতে পারবেন না (Self-referral allowed নয়)' };
    }
    if (ctx.email && owner.email && String(owner.email).toLowerCase() === String(ctx.email).toLowerCase()) {
        return { ok: false, message: 'আপনি নিজের Referral Code ব্যবহার করতে পারবেন না (Self-referral allowed নয়)' };
    }
    return { ok: true, referrer: owner, message: 'Referral code applied successfully' };
}

/* (#44) One referrer only, permanently. Returns true when created. */
function addReferralRelation(referrerId, referredId, resellersList) {
    referrerId = parseInt(referrerId);
    referredId = parseInt(referredId);
    if (isNaN(referrerId) || isNaN(referredId)) return false;
    if (referrerId === referredId) return false;                 // no self-referral
    var rels = getReferralRelations();
    for (var i = 0; i < rels.length; i++) {                      // already has a referrer
        if (parseInt(rels[i].referred_reseller_id) === referredId) return false;
    }
    var now = new Date().toISOString();
    rels.push({
        id: 'RR' + Date.now() + Math.floor(Math.random() * 1000),
        referrer_id: referrerId, referred_reseller_id: referredId,
        referrerId: referrerId, referredId: referredId,
        created_at: now, createdAt: now, status: 'active'
    });
    saveReferralRelations(rels);
    // keep the denormalised field in sync
    if (!resellersList) resellersList = getData(DB_KEYS.RESELLERS) || [];
    for (var j = 0; j < resellersList.length; j++) {
        if (parseInt(resellersList[j].id) === referredId) { setResellerReferredBy(resellersList[j], referrerId); break; }
    }
    return true;
}

/* Rebuild any missing relation rows from reseller.referredBy (self healing). */
function syncReferralRelationsFromResellers() {
    var resellers = getData(DB_KEYS.RESELLERS) || [];
    var rels = getReferralRelations();
    var have = {};
    for (var i = 0; i < rels.length; i++) have[String(parseInt(rels[i].referred_reseller_id))] = true;
    var added = false;
    for (var j = 0; j < resellers.length; j++) {
        var rb = resellerReferredBy(resellers[j]);
        if (rb === null) continue;
        if (have[String(resellers[j].id)]) continue;
        if (parseInt(rb) === parseInt(resellers[j].id)) continue;   // self
        var now = new Date().toISOString();
        rels.push({
            id: 'RR' + Date.now() + Math.floor(Math.random() * 1000),
            referrer_id: rb, referred_reseller_id: resellers[j].id,
            referrerId: rb, referredId: resellers[j].id,
            created_at: now, createdAt: now, status: 'active'
        });
        added = true;
    }
    if (added) saveReferralRelations(rels);
    return added;
}

function relationsOfReferrer(referrerId) {
    var rels = getReferralRelations(), out = [];
    for (var i = 0; i < rels.length; i++) {
        if (String(parseInt(rels[i].referrer_id)) === String(parseInt(referrerId))) out.push(rels[i]);
    }
    return out;
}
function referrerOf(referredId) {
    var rels = getReferralRelations();
    for (var i = 0; i < rels.length; i++) {
        if (String(parseInt(rels[i].referred_reseller_id)) === String(parseInt(referredId))) return parseInt(rels[i].referrer_id);
    }
    return null;
}

/* ---------- order statistics ---------- */
function isDeliveredOrder(o) { return o && String(o.status) === 'delivered'; }

function deliveredCountOf(resellerId) {
    var orders = getData(DB_KEYS.ORDERS) || [], n = 0;
    for (var i = 0; i < orders.length; i++) {
        if (String(orders[i].resellerId) === String(resellerId) && isDeliveredOrder(orders[i])) n++;
    }
    return n;
}
function totalOrderCountOf(resellerId) {
    var orders = getData(DB_KEYS.ORDERS) || [], n = 0;
    for (var i = 0; i < orders.length; i++) {
        if (String(orders[i].resellerId) === String(resellerId)) n++;
    }
    return n;
}
/* Map: resellerId -> delivered order count (built once per call) */
function deliveredMap() {
    var orders = getData(DB_KEYS.ORDERS) || [], m = {};
    for (var i = 0; i < orders.length; i++) {
        if (!isDeliveredOrder(orders[i])) continue;
        var k = String(orders[i].resellerId);
        m[k] = (m[k] || 0) + 1;
    }
    return m;
}

/* (#26,#31) A referred reseller is "qualified" at >= 5 delivered orders. */
function qualifiedReferralCount(referrerId, dmap) {
    var rels = relationsOfReferrer(referrerId);
    if (!dmap) dmap = deliveredMap();
    var n = 0;
    for (var i = 0; i < rels.length; i++) {
        var d = dmap[String(parseInt(rels[i].referred_reseller_id))] || 0;
        if (d >= REFERRAL_CFG.TIER2_MIN_DELIVERED) n++;
    }
    return n;
}
/* (#26,#46) Tier 2 unlocks at >= 50 QUALIFIED referred resellers. */
function referralTierOf(referrerId, dmap) {
    return qualifiedReferralCount(referrerId, dmap) >= REFERRAL_CFG.TIER2_MIN_REFERRALS ? 2 : 1;
}
function referralRateOfTier(tier) {
    return parseInt(tier) === 2 ? REFERRAL_CFG.TIER2_RATE : REFERRAL_CFG.TIER1_RATE;
}
function referralRateOf(referrerId, dmap) {
    return referralRateOfTier(referralTierOf(referrerId, dmap));
}

/* ---------- earnings ---------- */
function commissionsOfReferrer(referrerId) {
    var all = getReferralCommissions(), out = [];
    for (var i = 0; i < all.length; i++) {
        if (String(parseInt(all[i].referrer_id)) === String(parseInt(referrerId))) out.push(all[i]);
    }
    return out;
}
function referralEarnings(referrerId) {
    var c = commissionsOfReferrer(referrerId), t = 0;
    for (var i = 0; i < c.length; i++) if (c[i].status === 'credited') t += Number(c[i].amount) || 0;
    return t;
}
function referralEarningsSince(referrerId, sinceMs) {
    var c = commissionsOfReferrer(referrerId), t = 0;
    for (var i = 0; i < c.length; i++) {
        if (c[i].status !== 'credited') continue;
        var ts = new Date(c[i].created_at || 0).getTime();
        if (!isNaN(ts) && ts >= sinceMs) t += Number(c[i].amount) || 0;
    }
    return t;
}
function referralEarningsBetween(referrerId, a, b) {
    var c = commissionsOfReferrer(referrerId), t = 0;
    for (var i = 0; i < c.length; i++) {
        if (c[i].status !== 'credited') continue;
        var ts = new Date(c[i].created_at || 0).getTime();
        if (!isNaN(ts) && ts >= a && ts < b) t += Number(c[i].amount) || 0;
    }
    return t;
}
function startOfTodayMs() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

/* ---------- (#33) the commission engine ----------
   Idempotent. Safe to call from anywhere, any number of times.
   - delivered order of a referred reseller -> exactly ONE commission row
   - order later cancelled / returned / rejected / failed -> reversed
   - re-delivered -> re-credited (still one row per order)
------------------------------------------------- */
function syncReferralCommissions() {
    try {
        ensureReferralCodes();
        syncReferralRelationsFromResellers();
    } catch (e) {}

    var orders = getData(DB_KEYS.ORDERS) || [];
    var comms = getReferralCommissions();
    var rels = getReferralRelations();

    var relByReferred = {};
    for (var r = 0; r < rels.length; r++) {
        relByReferred[String(parseInt(rels[r].referred_reseller_id))] = rels[r];
    }
    var byOrder = {};
    for (var c = 0; c < comms.length; c++) byOrder[String(comms[c].order_id)] = comms[c];

    var dmap = deliveredMap();
    var resellers = null, resellersDirty = false, commsDirty = false;
    function RS() { if (!resellers) resellers = getData(DB_KEYS.RESELLERS) || []; return resellers; }
    function credit(uid, amt, note, source) {
        var list = RS();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(uid)) {
                list[i].balance = (Number(list[i].balance) || 0) + amt;
                list[i].totalEarning = (Number(list[i].totalEarning) || 0) + amt;
                break;
            }
        }
        resellersDirty = true;
        addTransaction(uid, 'credit', amt, note, source);
    }
    function debit(uid, amt, note, source) {
        var list = RS();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(uid)) {
                list[i].balance = Math.max(0, (Number(list[i].balance) || 0) - amt);
                list[i].totalEarning = Math.max(0, (Number(list[i].totalEarning) || 0) - amt);
                break;
            }
        }
        resellersDirty = true;
        addTransaction(uid, 'debit', amt, note, source);
    }

    for (var o = 0; o < orders.length; o++) {
        var ord = orders[o];
        if (!ord) continue;
        var rel = relByReferred[String(parseInt(ord.resellerId))];
        if (!rel) continue;
        var referrerId = parseInt(rel.referrer_id);
        if (isNaN(referrerId)) continue;
        var key = String(ord.id);
        var row = byOrder[key];

        if (isDeliveredOrder(ord)) {
            if (!row) {
                var tier = referralTierOf(referrerId, dmap);
                var amt = referralRateOfTier(tier);
                var now = new Date().toISOString();
                row = {
                    id: 'RC' + Date.now() + Math.floor(Math.random() * 1000),
                    referrer_id: referrerId, referred_reseller_id: parseInt(rel.referred_reseller_id),
                    referrerId: referrerId, referredId: parseInt(rel.referred_reseller_id),
                    order_id: ord.id,
                    amount: amt, tier: tier,
                    status: 'credited',
                    order_status: 'delivered',
                    created_at: now, createdAt: now,
                    reversed_at: null
                };
                comms.push(row); byOrder[key] = row; commsDirty = true;
                var lbl = tier === 2 ? 'Referral Commission — Tier 2' : 'Referral Commission';
                credit(referrerId, amt, lbl + ' / Order #' + ord.id + ' / +৳' + amt, 'referral');
            } else if (row.status === 'reversed') {
                row.status = 'credited'; row.reversed_at = null;
                row.order_status = 'delivered'; commsDirty = true;
                var l2 = row.tier === 2 ? 'Referral Commission — Tier 2' : 'Referral Commission';
                credit(referrerId, Number(row.amount) || 0, l2 + ' / Order #' + ord.id + ' / +৳' + row.amount + ' (re-delivered)', 'referral');
            } else {
                if (row.order_status !== 'delivered') { row.order_status = 'delivered'; commsDirty = true; }
            }
        } else {
            if (row && row.status === 'credited') {
                row.status = 'reversed';
                row.reversed_at = new Date().toISOString();
                row.order_status = String(ord.status || '');
                commsDirty = true;
                debit(referrerId, Number(row.amount) || 0,
                    'Referral commission reversed — Order #' + ord.id + ' (' + (ord.status || 'not delivered') + ') / −৳' + row.amount,
                    'referral');
            } else if (row && row.order_status !== String(ord.status || '')) {
                row.order_status = String(ord.status || '');
                commsDirty = true;
            }
        }
    }

    if (commsDirty) saveReferralCommissions(comms);
    if (resellersDirty && resellers) setData(DB_KEYS.RESELLERS, resellers);
    return comms;
}

/* ---------- (#30,#31,#32) everything the reseller panel needs ---------- */
function referralStats(referrerId) {
    syncReferralCommissions();
    var dmap = deliveredMap();
    var rels = relationsOfReferrer(referrerId);
    var tier = referralTierOf(referrerId, dmap);
    var rate = referralRateOfTier(tier);
    var comms = commissionsOfReferrer(referrerId);

    var rows = [], qualified = 0;
    for (var i = 0; i < rels.length; i++) {
        var rid = parseInt(rels[i].referred_reseller_id);
        var r = findResellerById(rid);
        var delivered = dmap[String(rid)] || 0;
        var isQ = delivered >= REFERRAL_CFG.TIER2_MIN_DELIVERED;
        if (isQ) qualified++;
        var earn = 0;
        for (var k = 0; k < comms.length; k++) {
            if (String(parseInt(comms[k].referred_reseller_id)) === String(rid) && comms[k].status === 'credited') {
                earn += Number(comms[k].amount) || 0;
            }
        }
        rows.push({
            reseller: r || { id: rid, name: '(removed)', businessName: '-', status: 'removed' },
            resellerId: rid,
            joinDate: (r && (r.joinDate || r.approvalDate)) || (rels[i].created_at || '').slice(0, 10) || '-',
            totalOrders: totalOrderCountOf(rid),
            delivered: delivered,
            qualified: isQ,
            rate: rate,
            earnings: earn,
            status: (r && r.status) || 'unknown',
            lastOrderDate: lastOrderDateOf(rid)
        });
    }

    var now = Date.now();
    var today = startOfTodayMs();
    var d7 = now - 7 * 86400000, d30 = now - 30 * 86400000, y1 = now - 365 * 86400000;

    return {
        totalReferred: rels.length,
        qualified: qualified,
        tier: tier,
        rate: rate,
        lifetime: referralEarnings(referrerId),
        today: referralEarningsSince(referrerId, today),
        last7: referralEarningsSince(referrerId, d7),
        last30: referralEarningsSince(referrerId, d30),
        lastYear: referralEarningsSince(referrerId, y1),
        neededForTier2: Math.max(0, REFERRAL_CFG.TIER2_MIN_REFERRALS - qualified),
        referred: rows
    };
}
function lastOrderDateOf(resellerId) {
    var orders = getData(DB_KEYS.ORDERS) || [], best = null;
    for (var i = 0; i < orders.length; i++) {
        if (String(orders[i].resellerId) !== String(resellerId)) continue;
        var t = new Date(orders[i].date || orders[i].createdAt || 0).getTime();
        if (isNaN(t)) continue;
        if (best === null || t > best) best = t;
    }
    return best ? new Date(best).toISOString().slice(0, 10) : '-';
}

/* (#36) Full referral link that pre-fills the register page. */
function referralLinkFor(code) {
    code = code || '';
    try {
        var base = window.location.origin + String(window.location.pathname).replace(/[^\/]*$/, '');
        return base + 'register.html?ref=' + encodeURIComponent(code);
    } catch (e) { return 'register.html?ref=' + encodeURIComponent(code); }
}
/* Read ?ref=CODE from the current URL (#36) */
function referralCodeFromUrl() {
    try {
        var m = window.location.search.match(/[?&]ref=([^&]*)/i);
        return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
}

/* ==========================================================================
   SUPPLIER REFERRAL SYSTEM
   --------------------------------------------------------------------------
   An INDEPENDENT referral programme for suppliers that mirrors the reseller
   programme but never shares storage with it:
     - storage          : rh_supplier_referral_relations / _commissions
     - code source      : supplier Business (Shop) Name + 4 digits
     - commission base  : DELIVERED orders that contain the referred
                          supplier's products
   Tier 1  : ৳5  per delivered order
   Tier 2  : ৳10 per delivered order, unlocked at >= 50 referred suppliers
             that EACH have >= 5 delivered orders.
   Tier 2 is NOT retroactive — amount + tier are frozen onto every commission
   row at creation time, so commissions earned on Tier 1 stay ৳5 forever.
   ========================================================================== */

/* ---------- storage helpers ---------- */
function getSupplierReferralRelations() {
    var r = getData(DB_KEYS.SUPPLIER_REFERRAL_RELATIONS);
    return Object.prototype.toString.call(r) === '[object Array]' ? r : [];
}
function saveSupplierReferralRelations(list) { setData(DB_KEYS.SUPPLIER_REFERRAL_RELATIONS, list); }
function getSupplierReferralCommissions() {
    var c = getData(DB_KEYS.SUPPLIER_REFERRAL_COMMISSIONS);
    return Object.prototype.toString.call(c) === '[object Array]' ? c : [];
}
function saveSupplierReferralCommissions(list) { setData(DB_KEYS.SUPPLIER_REFERRAL_COMMISSIONS, list); }

/* ---------- field accessors (camelCase + snake_case) ---------- */
function supplierRefCode(s) {
    if (!s) return '';
    return String(s.referralCode || s.referral_code || '').trim();
}
function supplierReferredBy(s) {
    if (!s) return null;
    var v = (s.referredBy !== undefined && s.referredBy !== null) ? s.referredBy : s.referred_by;
    if (v === undefined || v === null || v === '') return null;
    var n = parseInt(v);
    return isNaN(n) ? null : n;
}
function setSupplierRefCode(s, code) { if (s) { s.referralCode = code; s.referral_code = code; } }
function setSupplierReferredBy(s, id) { if (s) { s.referredBy = id; s.referred_by = id; } }

/* ONE canonical "this supplier's OWN referral code" resolver — the same rule as
   resellerOwnRefCode(). A page must never print `sup.referralCode` inline: a
   supplier registered before codes existed (or one whose code was cleared) would
   show an empty string, or a stale code belonging to somebody else. This repairs
   first (idempotent), then returns, and returns '' rather than inventing one. */
function supplierOwnRefCode(s) {
    if (!s) return '';
    try { if (typeof ensureSupplierReferralCodes === 'function') ensureSupplierReferralCodes(); } catch (e) {}
    var c = supplierRefCode(s);
    if (!c) {
        try {
            var sups = getData(DB_KEYS.SUPPLIERS) || [];
            for (var i = 0; i < sups.length; i++) {
                if (String(sups[i].id) === String(s.id)) { c = supplierRefCode(sups[i]); break; }
            }
        } catch (e) {}
    }
    return c || '';
}

/* ---------- unique code generation ----------
   Business Name + 4 digits, e.g. "ABC Fashion" -> ABCFASHION1024,
   a long name is shortened to its first 6 alnum chars -> ABC1024. */
function supplierReferralCodeBase(name) {
    var s = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s) s = 'SUPPLIER';
    if (s.length > 12) s = s.substring(0, 6);
    return s;
}
function generateSupplierReferralCode(name, excludeId) {
    var base = supplierReferralCodeBase(name);
    var list = getData(DB_KEYS.SUPPLIERS) || [];
    var used = {};
    for (var i = 0; i < list.length; i++) {
        if (excludeId && String(list[i].id) === String(excludeId)) continue;
        var c = supplierRefCode(list[i]);
        if (c) used[String(c).toUpperCase()] = true;
    }
    var code, n;
    for (var t = 0; t < 400; t++) {
        n = Math.floor(1000 + Math.random() * 9000);
        code = base + n;
        if (!used[code]) return code;
    }
    n = 1000;
    while (used[base + n] && n < 9999) n++;
    return base + n;
}
/* Give every supplier a unique code; repair duplicates. */
function ensureSupplierReferralCodes() {
    var list = getData(DB_KEYS.SUPPLIERS) || [];
    var changed = false, seen = {};
    for (var i = 0; i < list.length; i++) {
        var c = supplierRefCode(list[i]);
        if (!c || seen[c.toUpperCase()]) {
            setSupplierRefCode(list[i], generateSupplierReferralCode(list[i].shopName || list[i].name, list[i].id));
            changed = true;
        }
        seen[supplierRefCode(list[i]).toUpperCase()] = true;
    }
    if (changed) setData(DB_KEYS.SUPPLIERS, list);
    return changed;
}

/* ---------- lookup ---------- */
function findSupplierByCode(code) {
    code = String(code || '').trim().toUpperCase();
    if (!code) return null;
    var list = getData(DB_KEYS.SUPPLIERS) || [];
    for (var i = 0; i < list.length; i++) {
        if (supplierRefCode(list[i]).toUpperCase() === code) return list[i];
    }
    return null;
}
function findSupplierById(id) {
    var list = getData(DB_KEYS.SUPPLIERS) || [];
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
}

/* Validate a code typed during supplier registration.
   ctx may carry {id, phone, email} of the person registering. */
function validateSupplierReferralCode(code, ctx) {
    code = String(code || '').trim();
    if (!code) return { ok: true, none: true, message: '' };
    var owner = findSupplierByCode(code);
    if (!owner) return { ok: false, message: 'Invalid referral code' };
    if (owner.status === 'banned') return { ok: false, message: 'Invalid referral code' };
    ctx = ctx || {};
    if (ctx.id !== undefined && ctx.id !== null && String(owner.id) === String(ctx.id)) {
        return { ok: false, message: 'আপনি নিজের Referral Code ব্যবহার করতে পারবেন না (Self-referral allowed নয়)' };
    }
    if (ctx.phone && owner.phone && String(owner.phone) === String(ctx.phone)) {
        return { ok: false, message: 'আপনি নিজের Referral Code ব্যবহার করতে পারবেন না (Self-referral allowed নয়)' };
    }
    if (ctx.email && owner.email && String(owner.email).toLowerCase() === String(ctx.email).toLowerCase()) {
        return { ok: false, message: 'আপনি নিজের Referral Code ব্যবহার করতে পারবেন না (Self-referral allowed নয়)' };
    }
    return { ok: true, referrer: owner, message: 'Referral code applied successfully' };
}

/* One referrer only, permanently. Returns true when the relation is created. */
function addSupplierReferralRelation(referrerId, referredId, suppliersList) {
    referrerId = parseInt(referrerId);
    referredId = parseInt(referredId);
    if (isNaN(referrerId) || isNaN(referredId)) return false;
    if (referrerId === referredId) return false;                 // no self-referral
    var rels = getSupplierReferralRelations();
    for (var i = 0; i < rels.length; i++) {                      // already has a referrer
        if (parseInt(rels[i].referred_supplier_id) === referredId) return false;
    }
    var now = new Date().toISOString();
    rels.push({
        id: 'SR' + Date.now() + Math.floor(Math.random() * 1000),
        referrer_id: referrerId, referred_supplier_id: referredId,
        referrerId: referrerId, referredId: referredId,
        created_at: now, createdAt: now, status: 'active'
    });
    saveSupplierReferralRelations(rels);
    if (!suppliersList) suppliersList = getData(DB_KEYS.SUPPLIERS) || [];
    for (var j = 0; j < suppliersList.length; j++) {
        if (parseInt(suppliersList[j].id) === referredId) { setSupplierReferredBy(suppliersList[j], referrerId); break; }
    }
    /* Persist the denormalised field too — the relation row alone is not enough. */
    setData(DB_KEYS.SUPPLIERS, suppliersList);
    return true;
}

/* Rebuild missing relation rows from supplier.referredBy (self healing). */
function syncSupplierReferralRelationsFromSuppliers() {
    var suppliers = getData(DB_KEYS.SUPPLIERS) || [];
    var rels = getSupplierReferralRelations();
    var have = {};
    for (var i = 0; i < rels.length; i++) have[String(parseInt(rels[i].referred_supplier_id))] = true;
    var added = false;
    for (var j = 0; j < suppliers.length; j++) {
        var rb = supplierReferredBy(suppliers[j]);
        if (rb === null) continue;
        if (have[String(suppliers[j].id)]) continue;
        if (parseInt(rb) === parseInt(suppliers[j].id)) continue;   // self
        var now = new Date().toISOString();
        rels.push({
            id: 'SR' + Date.now() + Math.floor(Math.random() * 1000),
            referrer_id: rb, referred_supplier_id: suppliers[j].id,
            referrerId: rb, referredId: suppliers[j].id,
            created_at: now, createdAt: now, status: 'active'
        });
        added = true;
    }
    if (added) saveSupplierReferralRelations(rels);
    return added;
}

function supplierRelationsOfReferrer(referrerId) {
    var rels = getSupplierReferralRelations(), out = [];
    for (var i = 0; i < rels.length; i++) {
        if (String(parseInt(rels[i].referrer_id)) === String(parseInt(referrerId))) out.push(rels[i]);
    }
    return out;
}
function supplierReferrerOf(referredId) {
    var rels = getSupplierReferralRelations();
    for (var i = 0; i < rels.length; i++) {
        if (String(parseInt(rels[i].referred_supplier_id)) === String(parseInt(referredId))) return parseInt(rels[i].referrer_id);
    }
    return null;
}

/* ---------- supplier order statistics ----------
   An order "belongs" to a supplier when any line item carries that
   supplierId, or references a product the supplier owns (this is exactly
   the rule the supplier dashboard already uses). */
function supplierProductIdSet(supplierId) {
    var ps = getData(DB_KEYS.PRODUCTS) || [], s = {};
    for (var i = 0; i < ps.length; i++) {
        if (String(ps[i].supplierId) === String(supplierId)) s[String(ps[i].id)] = true;
    }
    return s;
}
function orderBelongsToSupplier(o, supplierId, ids) {
    if (!o) return false;
    if (o.items && o.items.length) {
        for (var k = 0; k < o.items.length; k++) {
            var it = o.items[k] || {};
            if (String(it.supplierId) === String(supplierId)) return true;
            if (ids && ids[String(it.productId)]) return true;
        }
        return false;
    }
    if (o.productId) { if (ids && ids[String(o.productId)]) return true; }
    return false;
}
function supplierDeliveredCountOf(supplierId) {
    var orders = getData(DB_KEYS.ORDERS) || [], ids = supplierProductIdSet(supplierId), n = 0;
    for (var i = 0; i < orders.length; i++) {
        if (isDeliveredOrder(orders[i]) && orderBelongsToSupplier(orders[i], supplierId, ids)) n++;
    }
    return n;
}
function supplierTotalOrderCountOf(supplierId) {
    var orders = getData(DB_KEYS.ORDERS) || [], ids = supplierProductIdSet(supplierId), n = 0;
    for (var i = 0; i < orders.length; i++) {
        if (orderBelongsToSupplier(orders[i], supplierId, ids)) n++;
    }
    return n;
}
/* Map: supplierId -> delivered order count. Built once per call. */
function supplierDeliveredMap() {
    var suppliers = getData(DB_KEYS.SUPPLIERS) || [];
    var m = {}, ids = {};
    for (var s = 0; s < suppliers.length; s++) {
        var sid = String(suppliers[s].id);
        ids[sid] = supplierProductIdSet(sid);
        m[sid] = 0;
    }
    var orders = getData(DB_KEYS.ORDERS) || [];
    for (var i = 0; i < orders.length; i++) {
        if (!isDeliveredOrder(orders[i])) continue;
        for (var k in m) {
            if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
            if (orderBelongsToSupplier(orders[i], k, ids[k])) m[k]++;
        }
    }
    return m;
}

/* A referred supplier is "qualified" at >= 5 delivered orders. */
function qualifiedSupplierReferralCount(referrerId, dmap) {
    var rels = supplierRelationsOfReferrer(referrerId);
    if (!dmap) dmap = supplierDeliveredMap();
    var n = 0;
    for (var i = 0; i < rels.length; i++) {
        var d = dmap[String(parseInt(rels[i].referred_supplier_id))] || 0;
        if (d >= SUPPLIER_REFERRAL_CFG.TIER2_MIN_DELIVERED) n++;
    }
    return n;
}
function supplierReferralTierOf(referrerId, dmap) {
    return qualifiedSupplierReferralCount(referrerId, dmap) >= SUPPLIER_REFERRAL_CFG.TIER2_MIN_REFERRALS ? 2 : 1;
}
function supplierReferralRateOfTier(tier) {
    return parseInt(tier) === 2 ? SUPPLIER_REFERRAL_CFG.TIER2_RATE : SUPPLIER_REFERRAL_CFG.TIER1_RATE;
}
function supplierReferralRateOf(referrerId, dmap) {
    return supplierReferralRateOfTier(supplierReferralTierOf(referrerId, dmap));
}

/* ---------- earnings ---------- */
function supplierCommissionsOfReferrer(referrerId) {
    var all = getSupplierReferralCommissions(), out = [];
    for (var i = 0; i < all.length; i++) {
        if (String(parseInt(all[i].referrer_id)) === String(parseInt(referrerId))) out.push(all[i]);
    }
    return out;
}
/* ==========================================================================
   SUPPLIER RATING  (2026-09-15)
   THE one place a supplier's average rating is computed.

   Reviews live in `rh_reviews`, one row per review, tied to a product by
   `productId` (with `productName` as the legacy fallback — the same match the
   Reviews page has always used). A supplier's rating is the MEAN of the scores
   left on ITS OWN products: two 4-star and one 5-star review reads 4.3, not 5.

   Returns { avg, count }. With no reviews `avg` is 0 and `count` is 0.
   Callers MUST show that honestly. The dashboard used to fall back to a
   hard-coded '5.0', so a supplier nobody had reviewed yet displayed a perfect
   score — a flattering default is still a wrong number.
   ========================================================================== */
function supplierRatingSummary(supplierId) {
    var sid = String(supplierId === undefined || supplierId === null ? '' : supplierId);
    var none = { avg: 0, count: 0 };
    if (!sid) return none;
    try {
        var revs = asArray(getData(DB_KEYS.REVIEWS));
        if (!revs.length) return none;
        /* this supplier's own products, indexed by id and by name */
        var ids = {}, names = {}, prods = asArray(getData(DB_KEYS.PRODUCTS));
        for (var i = 0; i < prods.length; i++) {
            var p = prods[i];
            if (!p || String(p.supplierId) !== sid) continue;
            if (p.id !== undefined && p.id !== null) ids[String(p.id)] = 1;
            if (p.name) names[String(p.name)] = 1;
        }
        /* The review writer stores `productId: orderId`, so that field does NOT
           hold a product id. Accept a review whose ORDER contains one of this
           supplier's lines as well, or those rows would never be counted. */
        var ordersMine = {};
        try {
            var ords = asArray(getData(DB_KEYS.ORDERS));
            for (var oi = 0; oi < ords.length; oi++) {
                var o = ords[oi];
                if (!o || o.id === undefined || o.id === null) continue;
                var items = (typeof orderLineItems === 'function') ? asArray(orderLineItems(o)) : asArray(o.items);
                for (var ii = 0; ii < items.length; ii++) {
                    var it = items[ii];
                    var isMine = (typeof orderItemIsSupplier === 'function')
                        ? orderItemIsSupplier(it, sid)
                        : (String(it && it.supplierId) === sid);
                    if (isMine) { ordersMine[String(o.id)] = 1; break; }
                }
            }
        } catch (e2) {}
        var sum = 0, n = 0;
        for (var j = 0; j < revs.length; j++) {
            var r = revs[j];
            if (!r) continue;
            var mine = (r.productId !== undefined && r.productId !== null &&
                        (ids[String(r.productId)] || ordersMine[String(r.productId)])) ||
                       (r.orderId !== undefined && r.orderId !== null && ordersMine[String(r.orderId)]) ||
                       (r.productName && names[String(r.productName)]);
            if (!mine) continue;
            var v = Number(r.rating);
            /* a row with no usable score is not a score — never count it as 0 */
            if (!isFinite(v) || v <= 0) continue;
            sum += v; n++;
        }
        return n ? { avg: sum / n, count: n } : none;
    } catch (e) { return none; }
}

/* --------------------------------------------------------------------------
   ONE-TIME REPAIR of supplier ratings already stored wrongly (2026-09-15).

   Until today the average was seeded with an imaginary 5-star review:
   `(sups[i].rating || 5) * (sups[i].reviews || 1)` fed into `(reviews || 1) + 1`,
   so a first 1-star review was stored as 3.0 and a 3-star as 4.0. Fixing the code
   alone would leave every EXISTING supplier showing a number that is still wrong
   until their next review — so the stored values are recomputed from the reviews
   themselves, once.

   Idempotent and additive: guarded by a marker key, never touches DB_VERSION
   (bumping that would wipe every rh_* key). A supplier with no reviews is set to
   rating 0 / reviews 0, which is the honest reading — not a flattering default.
   -------------------------------------------------------------------------- */
function migrateSupplierRatings() {
    var MARK = 'rh_ratings_recomputed';
    try {
        if (String(localStorage.getItem(MARK) || '') === 'v1') return;
    } catch (e) { return; }
    try {
        var sups = asArray(getData(DB_KEYS.SUPPLIERS));
        var changed = 0;
        for (var i = 0; i < sups.length; i++) {
            var s = sups[i];
            if (!s || s.id === undefined || s.id === null) continue;
            var rs = supplierRatingSummary(s.id);
            var newRating = rs.count ? Math.round(rs.avg * 10) / 10 : 0;
            var newCount = rs.count;
            if (Number(s.rating) !== newRating || Number(s.reviews) !== newCount) {
                s.rating = newRating;
                s.reviews = newCount;
                changed++;
            }
        }
        if (changed) setData(DB_KEYS.SUPPLIERS, sups);
    } catch (e2) {}
    try { localStorage.setItem(MARK, 'v1'); } catch (e3) {}
}

function supplierReferralEarnings(referrerId) {
    var c = supplierCommissionsOfReferrer(referrerId), t = 0;
    for (var i = 0; i < c.length; i++) if (c[i].status === 'credited') t += Number(c[i].amount) || 0;
    return t;
}
function supplierReferralEarningsSince(referrerId, sinceMs) {
    var c = supplierCommissionsOfReferrer(referrerId), t = 0;
    for (var i = 0; i < c.length; i++) {
        if (c[i].status !== 'credited') continue;
        var ts = new Date(c[i].created_at || 0).getTime();
        if (!isNaN(ts) && ts >= sinceMs) t += Number(c[i].amount) || 0;
    }
    return t;
}
function supplierReferralEarningsBetween(referrerId, a, b) {
    var c = supplierCommissionsOfReferrer(referrerId), t = 0;
    for (var i = 0; i < c.length; i++) {
        if (c[i].status !== 'credited') continue;
        var ts = new Date(c[i].created_at || 0).getTime();
        if (!isNaN(ts) && ts >= a && ts < b) t += Number(c[i].amount) || 0;
    }
    return t;
}

/* ---------- the commission engine ----------
   Idempotent and safe to call from anywhere, any number of times:
     - delivered order of a referred supplier -> exactly ONE commission row
     - order later cancelled / returned / rejected / failed -> reversed
     - re-delivered -> re-credited (still one row per order)
   Commission is added to the supplier's EXISTING balance — no new wallet. */
function syncSupplierReferralCommissions() {
    try {
        ensureSupplierReferralCodes();
        syncSupplierReferralRelationsFromSuppliers();
    } catch (e) {}

    var orders = getData(DB_KEYS.ORDERS) || [];
    var comms = getSupplierReferralCommissions();
    var rels = getSupplierReferralRelations();

    var relByReferred = {};
    for (var r = 0; r < rels.length; r++) {
        relByReferred[String(parseInt(rels[r].referred_supplier_id))] = rels[r];
    }
    var byOrder = {};
    for (var c = 0; c < comms.length; c++) byOrder[String(comms[c].order_id)] = comms[c];

    var dmap = supplierDeliveredMap();
    var suppliers = null, suppliersDirty = false, commsDirty = false;
    function SP() { if (!suppliers) suppliers = getData(DB_KEYS.SUPPLIERS) || []; return suppliers; }
    function credit(uid, amt, note, source) {
        var list = SP();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(uid)) {
                list[i].balance = (Number(list[i].balance) || 0) + amt;
                break;
            }
        }
        suppliersDirty = true;
        addTransaction(uid, 'credit', amt, note, source);
    }
    function debit(uid, amt, note, source) {
        var list = SP();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(uid)) {
                list[i].balance = Math.max(0, (Number(list[i].balance) || 0) - amt);
                break;
            }
        }
        suppliersDirty = true;
        addTransaction(uid, 'debit', amt, note, source);
    }

    /* supplierId -> productId set, memoised */
    var idCache = {};
    for (var s = 0; s < rels.length; s++) {
        var sid = String(parseInt(rels[s].referred_supplier_id));
        if (!idCache[sid]) idCache[sid] = supplierProductIdSet(sid);
    }

    for (var o = 0; o < orders.length; o++) {
        var ord = orders[o];
        if (!ord) continue;

        /* find which referred supplier (if any) this order belongs to */
        var matchedId = null;
        for (var m in relByReferred) {
            if (!Object.prototype.hasOwnProperty.call(relByReferred, m)) continue;
            if (orderBelongsToSupplier(ord, m, idCache[m])) { matchedId = m; break; }
        }
        if (matchedId === null) continue;

        var rel = relByReferred[matchedId];
        var referrerId = parseInt(rel.referrer_id);
        if (isNaN(referrerId)) continue;
        var referredId = parseInt(rel.referred_supplier_id);
        var key = String(ord.id);
        var row = byOrder[key];

        if (isDeliveredOrder(ord)) {
            if (!row) {
                var tier = supplierReferralTierOf(referrerId, dmap);
                var amt = supplierReferralRateOfTier(tier);
                var sup = findSupplierById(referredId);
                var sName = (sup && (sup.shopName || sup.name)) || ('#' + referredId);
                var now = new Date().toISOString();
                row = {
                    id: 'SRC' + Date.now() + Math.floor(Math.random() * 1000),
                    referrer_id: referrerId, referred_supplier_id: referredId,
                    referrerId: referrerId, referredId: referredId,
                    order_id: ord.id,
                    amount: amt, tier: tier,
                    status: 'credited',
                    order_status: 'delivered',
                    created_at: now, createdAt: now,
                    reversed_at: null
                };
                comms.push(row); byOrder[key] = row; commsDirty = true;
                var lbl = tier === 2 ? 'Referral Commission — Tier 2' : 'Referral Commission';
                credit(referrerId, amt, lbl + ' / Supplier: ' + sName + ' / Order #' + ord.id + ' / +৳' + amt, 'supplier_referral');
            } else if (row.status === 'reversed') {
                row.status = 'credited'; row.reversed_at = null;
                row.order_status = 'delivered'; commsDirty = true;
                var l2 = row.tier === 2 ? 'Referral Commission — Tier 2' : 'Referral Commission';
                credit(referrerId, Number(row.amount) || 0, l2 + ' / Order #' + ord.id + ' / +৳' + row.amount + ' (re-delivered)', 'supplier_referral');
            } else {
                if (row.order_status !== 'delivered') { row.order_status = 'delivered'; commsDirty = true; }
            }
        } else {
            if (row && row.status === 'credited') {
                row.status = 'reversed';
                row.reversed_at = new Date().toISOString();
                row.order_status = String(ord.status || '');
                commsDirty = true;
                debit(referrerId, Number(row.amount) || 0,
                    'Referral commission reversed — Order #' + ord.id + ' (' + (ord.status || 'not delivered') + ') / −৳' + row.amount,
                    'supplier_referral');
            } else if (row && row.order_status !== String(ord.status || '')) {
                row.order_status = String(ord.status || '');
                commsDirty = true;
            }
        }
    }

    if (commsDirty) saveSupplierReferralCommissions(comms);
    if (suppliersDirty && suppliers) setData(DB_KEYS.SUPPLIERS, suppliers);
    return comms;
}

/* ---------- everything the supplier panel needs ---------- */
function supplierReferralStats(referrerId) {
    syncSupplierReferralCommissions();
    var dmap = supplierDeliveredMap();
    var rels = supplierRelationsOfReferrer(referrerId);
    var tier = supplierReferralTierOf(referrerId, dmap);
    var rate = supplierReferralRateOfTier(tier);
    var comms = supplierCommissionsOfReferrer(referrerId);

    var rows = [], qualified = 0;
    for (var i = 0; i < rels.length; i++) {
        var rid = parseInt(rels[i].referred_supplier_id);
        var s = findSupplierById(rid);
        var delivered = dmap[String(rid)] || 0;
        var isQ = delivered >= SUPPLIER_REFERRAL_CFG.TIER2_MIN_DELIVERED;
        if (isQ) qualified++;
        var earn = 0, ordCount = 0;
        for (var k = 0; k < comms.length; k++) {
            if (String(parseInt(comms[k].referred_supplier_id)) === String(rid) && comms[k].status === 'credited') {
                earn += Number(comms[k].amount) || 0;
                ordCount++;
            }
        }
        rows.push({
            supplier: s || { id: rid, name: '(removed)', shopName: '-', status: 'removed' },
            supplierId: rid,
            joinDate: (s && (s.joinDate || s.approvalDate)) || (rels[i].created_at || '').slice(0, 10) || '-',
            totalOrders: supplierTotalOrderCountOf(rid),
            delivered: delivered,
            qualified: isQ,
            rate: rate,
            earnings: earn,
            commissionOrders: ordCount,
            status: (s && s.status) || 'unknown',
            lastOrderDate: supplierLastOrderDateOf(rid)
        });
    }

    var now = Date.now();
    var today = startOfTodayMs();
    var d7 = now - 7 * 86400000, d30 = now - 30 * 86400000, y1 = now - 365 * 86400000;

    return {
        totalReferred: rels.length,
        qualified: qualified,
        tier: tier,
        rate: rate,
        lifetime: supplierReferralEarnings(referrerId),
        today: supplierReferralEarningsSince(referrerId, today),
        last7: supplierReferralEarningsSince(referrerId, d7),
        last30: supplierReferralEarningsSince(referrerId, d30),
        lastYear: supplierReferralEarningsSince(referrerId, y1),
        neededForTier2: Math.max(0, SUPPLIER_REFERRAL_CFG.TIER2_MIN_REFERRALS - qualified),
        referred: rows
    };
}
function supplierLastOrderDateOf(supplierId) {
    var orders = getData(DB_KEYS.ORDERS) || [], ids = supplierProductIdSet(supplierId), best = null;
    for (var i = 0; i < orders.length; i++) {
        if (!orderBelongsToSupplier(orders[i], supplierId, ids)) continue;
        var t = new Date(orders[i].date || orders[i].createdAt || 0).getTime();
        if (isNaN(t)) continue;
        if (best === null || t > best) best = t;
    }
    return best ? new Date(best).toISOString().slice(0, 10) : '-';
}

/* ---------- admin-side aggregate (reseller data stays separate) ---------- */
function adminSupplierReferralOverview() {
    syncSupplierReferralCommissions();
    var suppliers = getData(DB_KEYS.SUPPLIERS) || [];
    var rels = getSupplierReferralRelations();
    var comms = getSupplierReferralCommissions();
    var dmap = supplierDeliveredMap();

    var referred = {}, nT1 = 0, nT2 = 0, totalOrders = 0, totalComm = 0, qualified = 0;
    for (var i = 0; i < suppliers.length; i++) {
        var tier = supplierReferralTierOf(suppliers[i].id, dmap);
        if (supplierRelationsOfReferrer(suppliers[i].id).length) { if (tier === 2) nT2++; else nT1++; }
    }
    for (var r = 0; r < rels.length; r++) {
        referred[String(parseInt(rels[r].referred_supplier_id))] = true;
        var d = dmap[String(parseInt(rels[r].referred_supplier_id))] || 0;
        if (d >= SUPPLIER_REFERRAL_CFG.TIER2_MIN_DELIVERED) qualified++;
    }
    for (var c = 0; c < comms.length; c++) {
        if (comms[c].status !== 'credited') continue;
        totalComm += Number(comms[c].amount) || 0;
        totalOrders++;
    }
    var list = [], seen = {};
    for (var k = 0; k < rels.length; k++) {
        var rid = parseInt(rels[k].referrer_id);
        if (seen[rid]) continue;
        seen[rid] = true;
        var s = findSupplierById(rid);
        var relCount = supplierRelationsOfReferrer(rid).length;
        var st = supplierReferralStatsLite(rid, dmap);
        list.push({
            supplier: s || { id: rid, shopName: '(removed)', name: '-' },
            supplierId: rid,
            code: s ? supplierRefCode(s) : '',
            referees: relCount,
            qualified: st.qualified,
            tier: st.tier,
            earnings: supplierReferralEarnings(rid)
        });
    }
    return {
        totalReferrers: Object.keys(seen).length,
        totalReferred: Object.keys(referred).length,
        qualified: qualified,
        tier1: nT1,
        tier2: nT2,
        totalOrders: totalOrders,
        totalCommission: totalComm,
        referrers: list
    };
}
/* Lightweight per-referrer numbers (no full re-sync). */
function supplierReferralStatsLite(referrerId, dmap) {
    if (!dmap) dmap = supplierDeliveredMap();
    var rels = supplierRelationsOfReferrer(referrerId), q = 0;
    for (var i = 0; i < rels.length; i++) {
        var d = dmap[String(parseInt(rels[i].referred_supplier_id))] || 0;
        if (d >= SUPPLIER_REFERRAL_CFG.TIER2_MIN_DELIVERED) q++;
    }
    return { qualified: q, tier: q >= SUPPLIER_REFERRAL_CFG.TIER2_MIN_REFERRALS ? 2 : 1, referees: rels.length };
}

/* ---------- links ---------- */
function supplierReferralLinkFor(code) {
    code = code || '';
    try {
        var base = window.location.origin + String(window.location.pathname).replace(/[^\/]*$/, '');
        return base + 'index.html?ref=' + encodeURIComponent(code);
    } catch (e) { return 'index.html?ref=' + encodeURIComponent(code); }
}
function supplierReferralCodeFromUrl() {
    try {
        var m = window.location.search.match(/[?&]ref=([^&]*)/i);
        return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
}

/* ==========================================================================
   MY SHOP — per-reseller storefront (tenant isolated)
   --------------------------------------------------------------------------
   Every helper here takes an explicit reseller id (rid) and reads/writes
   ONLY that reseller's slice. There is no global "current shop" state, so
   one reseller can never read or mutate another reseller's:
   products / orders / customers / pixels / domain / category settings.
   ========================================================================== */

var DEFAULT_SHOP_THEME = {
    primary: '#e91e63',
    secondary: '#7c3aed',
    button: '#e91e63',
    text: '#111111',
    background: '#f5f6fa',
    header: '#0a0a0a',
    /* The MAIN CATEGORY BAR strip under the header. It is its own colour now —
       it used to borrow `header`, so a dark header forced a dark category band.
       Default is the old white bar, so every existing shop looks unchanged. */
    category: '#ffffff',
    footer: '#0a0a0a'
};

/* ONE canonical "which text colour is legible on this background" resolver.
   The storefront (.nav / category strip) and the Customize preview must agree,
   so the rule lives here instead of being copy-pasted per page.
   Returns dark ink on a light background, white on a dark one. */
function rhTextOnColor(hex) {
    try {
        var h = String(hex || '').replace('#', '').trim();
        if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
        if (h.length !== 6) return '#222222';
        var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        if (isNaN(r) || isNaN(g) || isNaN(b)) return '#222222';
        /* perceived luminance (ITU-R BT.601) */
        return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.6 ? '#222222' : '#ffffff';
    } catch (e) { return '#222222'; }
}
/* The colour of the full-width MAIN CATEGORY strip of one shop. One resolver so
   my-shop.html, my-shop-product.html and the Customize preview can never drift
   (the strip used to borrow `header`, so a dark header forced a dark bar). */
function shopCategoryColor(rid) {
    var t = null;
    try { t = getShopSettings(rid).theme; } catch (e) {}
    return (t && t.category) || DEFAULT_SHOP_THEME.category;
}

function defaultShopSetting() {
    return {
        enabled: true,
        theme: JSON.parse(JSON.stringify(DEFAULT_SHOP_THEME)),
        pixels: {
            meta: { id: '', connected: false, connectedAt: null },
            tiktok: { id: '', connected: false, connectedAt: null },
            instagram: { id: '', connected: false, connectedAt: null },
            capiEndpoint: ''
        },
        domain: { name: '', status: 'none', token: '', verifiedAt: null },
        /* #27-#31 — per-shop social links, stored against the reseller like
           every other My Shop setting (never global). */
        social: { facebook: '', instagram: '', tiktok: '' },
        /* Part 9 — the "Shop Smart Lifestyles" promotional banner on the My Shop
           homepage. DEFAULT ON, and scoped per reseller like every other shop
           setting, so one reseller switching it OFF never affects another. */
        banner: { show: true },
        /* 2026-09-15 — the mixed "all products" block above the footer.
           DEFAULT OFF: the homepage should show CATEGORY sections only. When a
           reseller turns it on it lists at most 30 products (6 per row by
           default; they may choose 4–10). Per shop, like every other setting. */
        homepage: { showAll: false, perRow: 6 },
        /* 2026-09-15 — sections the reseller REMOVED from their homepage.
           Holds section keys ("Main", "Main||Sub", "Main||Sub||SubSub").
           Removing a section is a display choice, never a data change: the
           products stay, they simply stop getting their own homepage block. */
        hiddenSections: [],
        /* Website Integration: sync automatically (default ON). The reseller can
           switch it off from the Website Integration page. */
        autoSync: true,
        /* ITEM 6 (spec, 2026-09-14) — may this reseller upload products to their
           OWN My Shop? Set by the ADMIN, per reseller. DEFAULT ON so every
           existing shop keeps working unchanged; the switch is a per-reseller
           value under rh_shop_settings[<rid>], never a global. */
        upload_enabled: true
    };
}

/* Does THIS shop currently get the premium treatment? The single question every
   storefront-facing query asks. When a reseller's premium/trial runs out their
   shop reverts to the FREE look — own products hidden, own design reverted —
   but NOTHING is deleted; it all comes back the moment they re-upgrade. */
function premiumShopOpen(rid) {
    try { return premiumState(rid).open; } catch (e) { return true; }
}

function getAllShopSettings() {
    var s = getData(DB_KEYS.SHOP_SETTINGS);
    /* stored as an OBJECT keyed by reseller id; guard against legacy arrays */
    if (Object.prototype.toString.call(s) === '[object Array]') return {};
    return (s && typeof s === 'object') ? s : {};
}
/* The RAW, ungated settings — the real stored record. Every WRITE path must go
   through this one, never through the gated view below, so a save made while a
   shop is locked can never overwrite the reseller's real design with defaults. */
function getShopSettingsRaw(rid) {
    var all = getAllShopSettings();
    var key = String(rid);
    var s = all[key];
    if (!s || typeof s !== 'object') s = defaultShopSetting();
    /* fill any missing key so older records never break the UI */
    var d = defaultShopSetting();
    if (!s.theme) s.theme = d.theme;
    for (var t in d.theme) { if (!s.theme[t]) s.theme[t] = d.theme[t]; }
    if (!s.pixels) s.pixels = d.pixels;
    for (var p in d.pixels) { if (!s.pixels[p]) s.pixels[p] = d.pixels[p]; }
    if (!s.domain) s.domain = d.domain;
    if (!s.social) s.social = { facebook: '', instagram: '', tiktok: '' };
    for (var sc in d.social) { if (s.social[sc] === undefined || s.social[sc] === null) s.social[sc] = d.social[sc]; }
    /* Part 9 — a reseller who saved settings BEFORE the banner flag existed must
       still read as ON, never as undefined (undefined would hide the banner). */
    if (!s.banner || typeof s.banner !== 'object') s.banner = { show: true };
    for (var bnr in d.banner) { if (s.banner[bnr] === undefined || s.banner[bnr] === null) s.banner[bnr] = d.banner[bnr]; }
    /* Homepage "all products" block — legacy shops read as OFF (the new default). */
    if (!s.homepage || typeof s.homepage !== 'object') s.homepage = { showAll: false, perRow: 6 };
    for (var hp in d.homepage) { if (s.homepage[hp] === undefined || s.homepage[hp] === null) s.homepage[hp] = d.homepage[hp]; }
    /* clamp per-row to the allowed 4–10 range */
    var _pr = parseInt(s.homepage.perRow, 10);
    s.homepage.perRow = (isNaN(_pr) || _pr < 4) ? 4 : (_pr > 10 ? 10 : _pr);
    if (!Object.prototype.toString.call(s.hiddenSections).match(/Array/)) s.hiddenSections = [];
    if (s.enabled === undefined) s.enabled = true;
    return s;
}

/* The STOREFRONT view of the settings. When the shop's premium/trial has run
   out, the customer sees the FREE shop: the default theme, no custom domain, no
   pixels, no custom banner/homepage choices — i.e. exactly what a brand-new free
   shop looks like. The shop NAME, LOGO and WHATSAPP number are NOT here; they
   live on the RESELLER record, so they stay visible through a lock untouched —
   which is exactly what the spec asks for. The real record is never modified. */
function getShopSettings(rid) {
    try {
        if (!premiumShopOpen(rid)) return defaultShopSetting();
    } catch (e) { }
    return getShopSettingsRaw(rid);
}
function saveShopSettings(rid, settings) {
    /* saveShopSettings-honest (2026-09-17, this request).
       setData() returns FALSE when the write does not land (storage full). This used
       to ignore that and return the settings anyway, so every caller believed the save
       succeeded: the toast said "✓", hsRender() re-read the OLD data, and the screen
       did not change. That is exactly "শুধু success লেখা হয়, কিন্তু কিছু হয় না".
       The project's own house rule is to check setData()'s return — this is where it
       was broken at the root. Returns the settings on success, FALSE on failure. */
    var all = getAllShopSettings();
    all[String(rid)] = settings;
    if (setData(DB_KEYS.SHOP_SETTINGS, all) === false) return false;
    return settings;
}
/* Shallow-patch helper: patchShopSettings(rid, {enabled:false})
   2026-09-18 — reads the RAW record, never the gated storefront view, so a patch
   can never write a locked shop's "free look" over its real saved design. */
function patchShopSettings(rid, patch) {
    var s = getShopSettingsRaw(rid);
    for (var k in patch) {
        if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
        if (patch[k] && typeof patch[k] === 'object' && !Object.prototype.toString.call(patch[k]).match(/Array/)) {
            for (var k2 in patch[k]) s[k][k2] = patch[k][k2];
        } else s[k] = patch[k];
    }
    /* propagates FALSE from saveShopSettings so the caller can tell the user */
    return saveShopSettings(rid, s);
}
/* Part 9 — is the "Shop Smart Lifestyles" promo banner ON for THIS shop?
   Reads the per-shop setting; anything unset / legacy reads as ON (default).
   Never global: the value lives under rh_shop_settings[<rid>]. */
function shopBannerOn(rid) {
    try {
        var s = getShopSettings(rid);
        if (!s || !s.banner || typeof s.banner !== 'object') return true;
        return s.banner.show !== false;
    } catch (e) { return true; }
}
function setShopBanner(rid, on) {
    return patchShopSettings(rid, { banner: { show: !!on } });
}
/* Part 9b (2026-09-18 request) — the reseller's OWN banners for the
   "Shop Smart Lifestyles" block: up to THREE, shown one after another.
   They drop into the SAME slot the demo uses, and the built-in design stays as
   the DEMO until they upload one.
   Stored beside `banner.show` (patchShopSettings merges nested keys, so setting
   images can never wipe the ON/OFF flag, and vice versa), and any data-URI image
   is spilled to .rhdata automatically, so this cannot fill the quota. */
var SHOP_BANNER_MAX = 3;
function shopBannerImages(rid) {
    try {
        var s = getShopSettings(rid);
        var b = (s && s.banner) || {};
        var a = [];
        if (Object.prototype.toString.call(b.images) === '[object Array]') {
            for (var i = 0; i < b.images.length; i++) if (b.images[i]) a.push(String(b.images[i]));
        }
        /* a single banner saved by the earlier version still shows */
        if (!a.length && b.image) a = [String(b.image)];
        return a.slice(0, SHOP_BANNER_MAX);
    } catch (e) { return []; }
}
function setShopBannerImages(rid, list) {
    var a = [];
    if (Object.prototype.toString.call(list) === '[object Array]') {
        for (var i = 0; i < list.length && a.length < SHOP_BANNER_MAX; i++) if (list[i]) a.push(String(list[i]));
    }
    return patchShopSettings(rid, { banner: { images: a, image: '' } });
}
/* The first uploaded banner (kept for any caller that only wants one). */
function shopBannerImage(rid) {
    var a = shopBannerImages(rid);
    return a.length ? a[0] : '';
}
function setShopBannerImage(rid, src) {
    return setShopBannerImages(rid, src ? [src] : []);
}
/* ==========================================================================
   MY SHOP DEFAULTS  (2026-09-18, this request)
   --------------------------------------------------------------------------
   The ADMIN designs a default My Shop that every reseller starts from:
     · up to THREE default "Shop Smart Lifestyles" banners, and
     · a default set of homepage blocks (the "Homepage Sections" rows).

   WHERE THEY LIVE. In their own key, `rh_myshop_defaults` — never inside
   `rh_settings` (the admin Settings page saves that object whole, so an
   unrelated save would wipe these) and never inside a reseller's
   `rh_shop_settings` (they are shared, not per-shop).

   HOW A RESELLER USES THEM — the word "default" means exactly one thing here:
   *whatever the reseller has not overridden yet*. So:

     · shopBannerDisplayImages(rid) -> the reseller's OWN banners if they have
       uploaded any, otherwise the admin's defaults. The storefront AND the
       settings page both read this ONE function, so the two can never disagree.
     · shopBlocks(rid) -> the reseller's OWN blocks if they have any, otherwise
       the admin's defaults.

   WHY THAT IS SAFE. Every write path (add / edit / delete / move) starts from
   the current list and saves the WHOLE list back. So the first time a reseller
   changes anything, the admin's default is copied into their own settings and
   then diverges. That is copy-on-write, and it is what makes "Reset to Default"
   possible afterwards — the default was never destroyed, only shadowed.

   NOTHING HERE TOUCHES A PRODUCT, AN ORDER OR ANOTHER RESELLER'S SHOP.
   ========================================================================== */
var MYSHOP_DEFAULT_BANNER_MAX = 3;
function myshopDefaultsRaw() {
    try {
        var d = getOne(DB_KEYS.MYSHOP_DEFAULTS);
        return (d && typeof d === 'object' && Object.prototype.toString.call(d) !== '[object Array]') ? d : {};
    } catch (e) { return {}; }
}
function myshopDefaultBannerImages() {
    var d = myshopDefaultsRaw();
    var a = d.bannerImages, out = [];
    if (Object.prototype.toString.call(a) === '[object Array]') {
        for (var i = 0; i < a.length && out.length < MYSHOP_DEFAULT_BANNER_MAX; i++) {
            if (a[i]) out.push(String(a[i]));
        }
    }
    return out;
}
function setMyshopDefaultBannerImages(list) {
    var a = [];
    if (Object.prototype.toString.call(list) === '[object Array]') {
        for (var i = 0; i < list.length && a.length < MYSHOP_DEFAULT_BANNER_MAX; i++) {
            if (list[i]) a.push(String(list[i]));
        }
    }
    var d = myshopDefaultsRaw();
    d.bannerImages = a;
    return setData(DB_KEYS.MYSHOP_DEFAULTS, d) !== false;
}
function myshopDefaultBlocks() {
    var d = myshopDefaultsRaw();
    var a = d.blocks;
    return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
}
function setMyshopDefaultBlocks(list) {
    var d = myshopDefaultsRaw();
    d.blocks = asArray(list);
    return setData(DB_KEYS.MYSHOP_DEFAULTS, d) !== false;
}
/* The banners the STOREFRONT must show.
   2026-09-18 — the premium gate lives here: a shop whose premium/trial has run out
   shows the FREE look (the platform defaults). Otherwise the reseller's OWN list
   wins — including an EMPTY one, which is a real answer ("I removed them all"). */
function shopBannerDisplayImages(rid) {
    var open = true;
    try { open = premiumShopOpen(rid); } catch (e) { }
    if (!open) return myshopDefaultBannerImages();          /* the free look */
    return shopBannerHasOwnList(rid) ? shopBannerSavedImages(rid) : myshopDefaultBannerImages();
}
/* ==========================================================================
   WHY A DELETE "DID NOT WORK"  (2026-09-18, this request)
   --------------------------------------------------------------------------
   Reported TWICE: "অ্যাডমিনের ডিফল্ট ব্যানার/ব্লক রিসেলার ডিলিট করতে পারতেছে না।"
   It was two separate faults, and the second one was the real one:

   FAULT 1 — the reader read a different record from the writer.
     · setShopBannerImages() WRITES the RAW record (getShopSettingsRaw)
     · shopBannerImages()    READ  the premium-GATED record (getShopSettings)
   When a shop's premium was not open the write landed and the read came back [],
   so the list fell to the admin's defaults. (Fixed below by reading the raw
   record through shopBannerSavedImages.)

   FAULT 2 — "empty" and "never touched" were the SAME VALUE.
     own = []  ->  fall back to the ADMIN's defaults
   So deleting the LAST item put it straight back, and emptying the list restored
   the whole default set. Measured on the real page:
       delete banner #1 -> 2 shown   ok
       delete banner #2 -> 1 shown   ok
       delete banner #3 -> 3 shown   <<< all three came back
       delete the only block -> still there
       (admin has 1 banner) delete -> still there
   Which is exactly "ডিলিট করা যাইতেছে না".

   THE FIX — the PRESENCE of the key is the signal, not its length:
     banner.images present as an ARRAY (even [])  => the reseller has their OWN
                                                     list; never fall back
     banner.images absent                         => never touched; use the default
   The same rule applies to `blocks`. "Reset to Default" therefore DELETES the
   keys rather than writing empty arrays, which is what makes it a true reset.
   ========================================================================== */
/* TRUE when the reseller has their OWN banner list — even an empty one.
   `banner.images` being an ARRAY is the marker; its LENGTH must never be used to
   decide this, or deleting the last banner would resurrect the admin's set. */
function shopBannerHasOwnList(rid) {
    try {
        var s = getShopSettingsRaw(rid);
        var b = (s && s.banner) || {};
        return Object.prototype.toString.call(b.images) === '[object Array]';
    } catch (e) { return false; }
}
function shopBannerSavedImages(rid) {
    try {
        var s = getShopSettingsRaw(rid);
        var b = (s && s.banner) || {};
        var a = [];
        if (Object.prototype.toString.call(b.images) === '[object Array]') {
            for (var i = 0; i < b.images.length; i++) if (b.images[i]) a.push(String(b.images[i]));
        }
        /* a single banner saved by the earlier version still shows */
        if (!a.length && b.image) a = [String(b.image)];
        return a.slice(0, SHOP_BANNER_MAX);
    } catch (e) { return []; }
}
/* What the SETTINGS PAGE must show: the reseller's own list if they have one —
   even an empty one, so a delete is never undone — else the admin's defaults.
   Read this, not the storefront view, so the person who deleted something always
   sees their own action, whatever their premium state is. */
function shopBannerManageImages(rid) {
    if (shopBannerHasOwnList(rid)) return shopBannerSavedImages(rid);
    return myshopDefaultBannerImages();
}
/* Drop the reseller's own banner list so the admin's defaults apply again.
   Deleting the KEY (not writing []) is what distinguishes "back to the default"
   from "I want no banners". */
function shopBannerClearOwn(rid) {
    try {
        var s = getShopSettingsRaw(rid);
        if (s.banner && typeof s.banner === 'object') { delete s.banner.images; delete s.banner.image; }
        return saveShopSettings(rid, s) === false ? false : true;
    } catch (e) { return false; }
}
/* TRUE while what is on screen is the ADMIN's default — the settings page uses
   this only to word its note honestly, never to change behaviour. */
function shopBannerUsingDefault(rid) {
    try { return !shopBannerHasOwnList(rid) && myshopDefaultBannerImages().length > 0; }
    catch (e) { return false; }
}
/* The reseller's OWN blocks only (never the admin's default).
   2026-09-18 (this request) — read from the RAW record, not the premium-gated one.
   shopBlockAdd/Update/Remove/Move all WRITE the raw record via patchShopSettings,
   so reading the gated record made the reader disagree with its writer: for a shop
   whose premium was not open the write landed (the raw list went 2 -> 1) and the
   reader still returned [], the list fell back to the admin's defaults, and the
   block came straight back — "শুধু উপায় লেখা উঠতেছে যে হইছে কিন্তু হয় না".
   The premium gate belongs on the STOREFRONT (see shopBlocksStorefront). */
function shopBlocksOwn(rid) {
    try {
        var st = getShopSettingsRaw(rid);
        var a = (st && st.blocks) ? st.blocks : [];
        return Object.prototype.toString.call(a).match(/Array/) ? a : [];
    } catch (e) { return []; }
}
/* TRUE when the reseller has their OWN block list — even an EMPTY one.
   The key's PRESENCE is the marker, never its length: with a length test, deleting
   the last block (or the only one) fell back to the admin's defaults and the block
   reappeared — "ব্লকগুলো ডিলিট করা যাইতেছে না". Same rule as the banners. */
function shopBlocksHasOwn(rid) {
    try {
        var st = getShopSettingsRaw(rid);
        return Object.prototype.toString.call(st && st.blocks) === '[object Array]';
    } catch (e) { return false; }
}
/* TRUE when this shop has moved away from the admin's default at all — drives
   whether the "Reset to Default" button has anything to do. Uses the PRESENCE of
   the reseller's own lists (not their length), so a shop that emptied its banners
   or blocks still counts as changed and can be reset back. */
function shopHasOwnOverrides(rid) {
    try { return shopBannerHasOwnList(rid) || shopBlocksHasOwn(rid); }
    catch (e) { return false; }
}
/* Put this shop back on the admin's defaults: remove the reseller's own banner
   list and their own homepage blocks.
   It DELETES the keys rather than writing empty arrays — that is precisely what
   makes the admin's defaults apply again (see the "empty vs never touched" note
   above). Writing [] here would leave the shop with NO banners and NO blocks.
   The banner ON/OFF switch is DELIBERATELY NOT touched — turning the banner off
   is a choice the reseller made, not an edit to be undone. */
function shopResetToDefault(rid) {
    try {
        var s = getShopSettingsRaw(rid);
        if (s.banner && typeof s.banner === 'object') { delete s.banner.images; delete s.banner.image; }
        delete s.blocks;
        return saveShopSettings(rid, s) === false ? false : true;
    } catch (e) { return false; }
}
/* What the ADMIN picks from while designing the default shop.
   Deliberately the PLATFORM category tree and the PLATFORM catalog — not one
   reseller's filtered view — because the default has to be designable before any
   particular reseller exists, and it is shared by all of them.
   `__default__` is a rid no real reseller can have (ids are numbers), so this
   can never read or write a real shop's own categories. */
var MYSHOP_DEFAULT_RID = '__default__';
function myshopDefaultMainCategories() { return shopMainCategories(MYSHOP_DEFAULT_RID); }
function myshopDefaultSubCategories(cat) { return shopSubCategories(MYSHOP_DEFAULT_RID, cat); }
function myshopDefaultSubSubCategories(cat, sub) { return shopSubSubCategories(MYSHOP_DEFAULT_RID, cat, sub); }
function myshopDefaultProducts() { return catalogProducts(); }

/* Add / update / remove / move ONE block in the ADMIN's default list.
   These mirror shopBlockAdd/Update/Remove/Move exactly — same object shape, same
   list semantics — so a default block can never drift from what
   shopBlockResolve() and the storefront expect. The ONLY difference is which
   store they write: these write rh_myshop_defaults, never a reseller's
   rh_shop_settings[<rid>]. */
function myshopDefaultBlockAdd(data) {
    var d = data || {};
    var b = {
        id: 'DBLK' + Date.now() + Math.floor(Math.random() * 1000),
        icon: String(d.icon || 'fa-bolt'),
        title: String(d.title || ''),
        subtitle: String(d.subtitle || ''),
        cat: String(d.cat || ''),
        sub: String(d.sub || ''),
        subsub: String(d.subsub || ''),
        products: asArray(d.products).map(String),
        hidden: false
    };
    var list = myshopDefaultBlocks().slice();
    list.push(b);
    return setMyshopDefaultBlocks(list) === false ? null : b.id;
}
function myshopDefaultBlockUpdate(id, patch) {
    var list = myshopDefaultBlocks().slice(), i, k;
    for (i = 0; i < list.length; i++) {
        if (String(list[i].id) !== String(id)) continue;
        for (k in patch) {
            if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
            list[i][k] = patch[k];
        }
        return setMyshopDefaultBlocks(list) === false ? false : true;
    }
    return false;
}
function myshopDefaultBlockRemove(id) {
    var list = myshopDefaultBlocks().slice(), out = [], i;
    for (i = 0; i < list.length; i++) if (String(list[i].id) !== String(id)) out.push(list[i]);
    if (out.length === list.length) return false;
    return setMyshopDefaultBlocks(out) === false ? false : true;
}
function myshopDefaultBlockMove(id, dir) {
    var list = myshopDefaultBlocks().slice(), idx = -1, i;
    for (i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) { idx = i; break; }
    if (idx === -1) return false;
    var to = idx + (dir < 0 ? -1 : 1);
    if (to < 0 || to >= list.length) return false;
    var t = list[idx]; list[idx] = list[to]; list[to] = t;
    return setMyshopDefaultBlocks(list) === false ? false : true;
}
/* 2026-09-15 — the homepage "all products" block. ONE reader, so the storefront
   and the settings page can never disagree. Default OFF. */
/* ==========================================================================
   SHOP POLICIES  (2026-09-17, this request)
   --------------------------------------------------------------------------
   The footer of every shop shows DELIVERY POLICY / RETURN POLICY / PRIVACY /
   ABOUT US. They used to be dead links. Now the RESELLER writes each one in
   their own words and the footer opens it.
   Stored per shop in rh_shop_settings[rid].policies, so one reseller's policy
   can never appear on another's shop.
   ========================================================================== */
var SHOP_POLICY_KEYS = [
    { k: 'delivery', label: 'Delivery Policy' },
    { k: 'return',   label: 'Return Policy' },
    { k: 'privacy',  label: 'Privacy Policy' },
    { k: 'about',    label: 'About Us' }
];
/* Open one of the shop's own policy pages. Lives in app.js so EVERY page that
   shows the shop footer gets it - homepage, product, checkout.
   `rid` is read from the URL here rather than from a page-local variable, so this
   works on any page without depending on that page's own scope. */
window.shopPolicyOpen = function (key) {
    try {
        var rid = null;
        try {
            var m = String(location.search || '').match(/[?&]rid=([^&]+)/);
            if (m) rid = decodeURIComponent(m[1]);
        } catch (e) { }
        if (rid === null) { try { rid = (typeof RID !== 'undefined' && RID !== null) ? RID : null; } catch (e) { } }
        var text = (rid !== null && typeof shopPolicy === 'function') ? shopPolicy(rid, key) : '';
        if (!String(text).trim()) return;
        var titles = { delivery: 'Delivery Policy', 'return': 'Return Policy', privacy: 'Privacy Policy', about: 'About Us' };
        var title = titles[key] || 'Policy';
        var body = esc(String(text)).replace(/\n/g, '<br>');
        var ov = document.createElement('div');
        ov.className = 'pol-ov';
        ov.innerHTML = '<div class="pol-box"><div class="pol-hd"><b>' + esc(title) + '</b>' +
          '<button onclick="this.parentNode.parentNode.parentNode.remove()">&times;</button></div>' +
          '<div class="pol-bd">' + body + '</div></div>';
        ov.onclick = function (e) { if (e.target === ov) ov.remove(); };
        document.body.appendChild(ov);
    } catch (e) { }
};
function shopPolicies(rid) {
    try {
        var st = getShopSettings(rid);
        var p = (st && st.policies) ? st.policies : {};
        return (p && typeof p === 'object') ? p : {};
    } catch (e) { return {}; }
}
function shopPolicy(rid, key) {
    var p = shopPolicies(rid);
    return String(p[String(key)] || '');
}
function setShopPolicy(rid, key, text) {
    /* NOTE: patchShopSettings() treats a plain object as a MERGE TARGET and does
       `s[k][k2] = ...`. If the shop has no `policies` key yet, that writes into
       undefined and throws
         "Cannot set properties of undefined (setting 'delivery')".
       So build the whole settings object here and save it whole — no nested merge.
       2026-09-18 — read the RAW record for the same reason as patchShopSettings. */
    var st = getShopSettingsRaw(rid) || {};
    var all = shopPolicies(rid) || {};
    if (typeof all !== 'object') all = {};
    all[String(key)] = String(text || '');
    st.policies = all;
    var r = saveShopSettings(rid, st);
    return r === false ? false : true;
}
function shopHomepage(rid) {
    var d = { showAll: false, perRow: 6 };
    try {
        var s = getShopSettings(rid);
        if (s && s.homepage) return s.homepage;
    } catch (e) {}
    return d;
}
function setShopHomepage(rid, patch) {
    var cur = shopHomepage(rid);
    var next = { showAll: !!cur.showAll, perRow: cur.perRow };
    if (patch) {
        if (patch.showAll !== undefined) next.showAll = !!patch.showAll;
        if (patch.perRow !== undefined) {
            var n = parseInt(patch.perRow, 10);
            next.perRow = (isNaN(n) || n < 4) ? 4 : (n > 10 ? 10 : n);
        }
    }
    return patchShopSettings(rid, { homepage: next });
}
/* Sections the reseller removed from their homepage. ONE reader, used by the
   storefront and the settings page, so the two can never disagree. */
function shopHiddenSections(rid) {
    try {
        var s = getShopSettings(rid);
        var a = (s && s.hiddenSections) ? s.hiddenSections : [];
        return Object.prototype.toString.call(a).match(/Array/) ? a : [];
    } catch (e) { return []; }
}
function shopSectionHidden(rid, key) {
    var list = shopHiddenSections(rid);
    for (var i = 0; i < list.length; i++) if (String(list[i]) === String(key)) return true;
    return false;
}
function setShopSectionHidden(rid, key, hidden) {
    var list = shopHiddenSections(rid).slice();
    var out = [], i, found = false;
    for (i = 0; i < list.length; i++) {
        if (String(list[i]) === String(key)) { found = true; if (!hidden) continue; }
        out.push(list[i]);
    }
    if (hidden && !found) out.push(String(key));
    /* return TRUE/FALSE, not the settings object — callers test the result */
    var r = patchShopSettings(rid, { hiddenSections: out });
    return r === false ? false : true;
}

/* Parts 13/14 — SIDEBAR ACTIVE STATE, resolved from the ROUTE.
   Every reseller panel page carries its own copy of `.sidebar-menu`, and the
   copy is written with `class="active"` baked into the markup. A page created
   by copying another (customer-messages.html came from my-shop-orders.html)
   therefore ships with the WRONG item highlighted — two items lit at once and
   never the current page. Instead of trusting the baked-in class, this reads
   the current filename and lights exactly the one menu link that points at it.

   Safety: when no menu link matches the current file (standalone pages such as
   product.html / cart.html / transactions.html) the markup is left completely
   alone — so a page that intentionally highlights nothing still highlights
   nothing, and nothing can ever be blanked out by this function. */
function rhSyncSidebarActive() {
    try {
        var menu = document.querySelector('.sidebar-menu');
        if (!menu) return;
        var links = menu.querySelectorAll('a[href]');
        if (!links || !links.length) return;
        var file = String(location.pathname || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
        if (!file) return;

        var best = null;
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var h = String(a.getAttribute('href') || '').trim();
            if (!h || h.charAt(0) === '#' || /^javascript:/i.test(h)) continue;
            var f = h.split('#')[0].split('?')[0].split('/').pop().toLowerCase();
            if (f && f === file) { best = a; break; }        /* first match only */
        }
        if (!best) return;                                   /* not this page's menu */
        for (var j = 0; j < links.length; j++) links[j].classList.remove('active');
        best.classList.add('active');
    } catch (e) { /* a cosmetic highlight must never break a page */ }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rhSyncSidebarActive);
} else {
    rhSyncSidebarActive();
}


/* #31 — social links of ONE shop. Resolved from the shop's own settings, so
   one reseller's links can never appear in another reseller's footer. */
function shopSocial(rid) {
    var s = getShopSettings(rid);
    return (s && s.social) ? s.social : { facebook: '', instagram: '', tiktok: '' };
}

/* ---------- shop enable / disable (#15, #45, #47) ---------- */
function isShopEnabled(rid) {
    var s = getShopSettings(rid);
    return s.enabled !== false;
}
function setShopEnabled(rid, on) { return patchShopSettings(rid, { enabled: !!on }); }

/* ---------- ITEM 6 (spec, 2026-09-14): per-reseller product upload ----------
   "অ্যাডমিন চাইলে যেকোনো রিসেলারের মাই শপে প্রোডাক্ট আপলোড করার যে ফিচারটা অফ করে
   দিতে পারে ... আর এই বাটনটা অফ করে দিলে অটোমেটিকলি মাই শপ অর্ডারটা হাইড হয়ে যাবে
   রিসেলার প্যানেল থেকে।"
   ONE switch, read by every surface that has to obey it, so the reseller's
   button, the nav item and the orders page can never disagree about whether the
   feature is on. Defaults ON: an unset value must never lock a shop down. */
function isShopUploadEnabled(rid) {
    try {
        var s = getShopSettings(rid);
        return s.upload_enabled !== false;
    } catch (e) { return true; }
}
function setShopUploadEnabled(rid, on) { return patchShopSettings(rid, { upload_enabled: !!on }); }
/* The reseller panel's own session id, so a page does not have to pass it. */
function shopUploadEnabledForSession() {
    try {
        if (sessionStorage.getItem('user_type') !== 'reseller') return true;
        var uid = sessionStorage.getItem('user_id');
        if (!uid) return true;
        return isShopUploadEnabled(uid);
    } catch (e) { return true; }
}
/* Hide every reseller-panel entry point to the My Shop upload + My Shop Orders
   when the admin has switched uploads off. Driven from app.js (not from each
   page's markup) so all 27 reseller pages obey the same rule with no per-page
   edits, and so a page added later cannot forget it.
   Nothing is DELETED: the link and the button are hidden, the data is untouched,
   and switching the flag back on restores both immediately. */
function rhApplyShopUploadPolicy() {
    try {
        if (typeof shopUploadEnabledForSession !== 'function' || shopUploadEnabledForSession()) return;
        if (sessionStorage.getItem('user_type') !== 'reseller') return;
        var links = document.querySelectorAll('a[href]');
        for (var i = 0; i < links.length; i++) {
            var h = String(links[i].getAttribute('href') || '').split('?')[0].split('#')[0];
            if (h !== 'my-shop-orders.html' && h.slice(-18) !== '/my-shop-orders.html') continue;
            /* the nav <li> is hidden too, so no empty row is left behind */
            var li = links[i].closest ? links[i].closest('li') : null;
            (li || links[i]).style.display = 'none';
        }
        var badge = document.getElementById('mshopBadge');
        if (badge) badge.style.display = 'none';
    } catch (e) { /* a policy must never break a page */ }
}

/* ---------- category visibility (#20 - #25, #43) ---------- */
function getAllShopCategories() {
    var c = getData(DB_KEYS.SHOP_CATEGORIES);
    if (Object.prototype.toString.call(c) === '[object Array]') return {};
    return (c && typeof c === 'object') ? c : {};
}
function getShopCategories(rid) {
    /* 2026-09-18 — a lapsed shop falls back to the platform's DEFAULT category
       state; the reseller's own per-category ON/OFF choices are premium-era work
       and simply rest until they re-upgrade. */
    try { if (!premiumShopOpen(rid)) return { cats: {}, subs: {}, subsubs: {} }; } catch (e) { }
    var all = getAllShopCategories();
    var key = String(rid);
    if (!all[key]) all[key] = { cats: {}, subs: {}, subsubs: {} };
    if (!all[key].cats) all[key].cats = {};
    if (!all[key].subs) all[key].subs = {};
    if (!all[key].subsubs) all[key].subsubs = {};
    return all[key];
}
function saveShopCategories(rid, vis) {
    var all = getAllShopCategories();
    all[String(rid)] = vis;
    setData(DB_KEYS.SHOP_CATEGORIES, all);
    return vis;
}
/* level: 'cats' | 'subs' | 'subsubs'   key: name | 'cat|sub' | 'cat|sub|subsub' */
function setCategoryVisible(rid, level, key, on) {
    var v = getShopCategories(rid);
    v[level][key] = !!on;
    return saveShopCategories(rid, v);
}
/* Default = VISIBLE. Turning OFF only hides from that reseller's storefront;
   nothing is ever deleted from the database (#43). */
function isCategoryVisible(rid, level, key) {
    var v = getShopCategories(rid);
    var val = v[level][key];
    if (val !== undefined) return !!val;      /* an explicit per-shop setting wins */
    /* A main category the migration RETIRED from primary nav is stored with
       `hidden:true` on the record itself. That is an admin-level OFF, so it must
       hide it for every reseller until an admin re-enables it. The data is never
       deleted — see migrateCategoryTree() step 4. */
    if (level === 'cats') {
        var list = asArray(getData(DB_KEYS.CATEGORIES));
        for (var i = 0; i < list.length; i++) {
            if (!list[i] || String(list[i].name) !== String(key)) continue;
            if (list[i].hidden === true) return false;
        }
    }
    return true;
}
function shopCatKey(a, b, c) {
    var k = String(a || '');
    if (b !== undefined && b !== null && b !== '') k += '|' + b;
    if (c !== undefined && c !== null && c !== '') k += '|' + c;
    return k;
}
/* A product is visible in a shop only when its whole chain is ON. */
function productVisibleInShop(rid, p) {
    if (!p) return false;
    var cat = String(p.category || '').trim();
    var sub = String(p.section || p.subSection || '').trim();
    var subsub = String(p.subSub || '').trim();
    if (cat && !isCategoryVisible(rid, 'cats', cat)) return false;
    if (cat && sub && !isCategoryVisible(rid, 'subs', shopCatKey(cat, sub))) return false;
    if (cat && sub && subsub && !isCategoryVisible(rid, 'subsubs', shopCatKey(cat, sub, subsub))) return false;
    return true;
}

/* ---------- product ownership (#13, #51) ---------- */
function productOwnerType(p) {
    if (!p) return 'admin';
    var t = String(p.product_owner_type || p.productOwnerType || '').toLowerCase();
    if (t === 'reseller' || t === 'admin' || t === 'supplier') return t;
    /* A reseller-uploaded product ALWAYS carries an owner reseller id, so that
       id is checked BEFORE supplierId. Checking supplierId first was wrong for a
       product saved with an explicit `supplierId: null` (see
       reseller/my-products.html): `null` is falsy, so the test fell through and
       the product was reported as 'supplier' — which made the reseller's own
       product look like a platform product, leaking it into admin/supplier views
       and hiding the reseller's own listings. */
    if (p.ownerResellerId !== undefined && p.ownerResellerId !== null && p.ownerResellerId !== '') return 'reseller';
    if (p.product_owner_id !== undefined && p.product_owner_id !== null && p.product_owner_id !== '') return 'reseller';
    var sup = (p.supplierId !== undefined && p.supplierId !== null && p.supplierId !== '') ? p.supplierId
            : (p.supplier_id !== undefined && p.supplier_id !== null && p.supplier_id !== '') ? p.supplier_id : null;
    if (sup !== null) return 'supplier';
    return 'admin';
}
function productOwnerId(p) {
    if (!p) return null;
    /* Read the explicit owner field first, then the reseller field. */
    var v = (p.product_owner_id !== undefined && p.product_owner_id !== null) ? p.product_owner_id : p.ownerResellerId;
    if (v !== undefined && v !== null && v !== '') return v;
    /* A SUPPLIER product does not always carry product_owner_id: the supplier's own
       "Add New Product" form writes only `supplierId` (+ supplierName/supplierSid).
       Without this fallback productOwnerType() said 'supplier' while productOwnerId()
       returned null, so every ownership test that needs the ID (msgAttachableProducts,
       isResellerOwnProduct, any per-owner grouping) silently dropped the product —
       the supplier could not even attach their own new product to a message.
       The condition below mirrors productOwnerType() EXACTLY (same field order, same
       reseller-first precedence) so the type and the id can never disagree. */
    if (p.ownerResellerId !== undefined && p.ownerResellerId !== null && p.ownerResellerId !== '') return p.ownerResellerId;
    if (p.product_owner_id !== undefined && p.product_owner_id !== null && p.product_owner_id !== '') return p.product_owner_id;
    var sup = (p.supplierId !== undefined && p.supplierId !== null && p.supplierId !== '') ? p.supplierId
            : (p.supplier_id !== undefined && p.supplier_id !== null && p.supplier_id !== '') ? p.supplier_id : null;
    if (sup !== null) return sup;
    return null;
}
function isResellerOwnProduct(p, rid) {
    return productOwnerType(p) === 'reseller' && String(productOwnerId(p)) === String(rid);
}
/* Products a given reseller may UPLOAD into — admin's existing hierarchy only. */
function shopUploadCategories() {
    var cats = getData(DB_KEYS.CATEGORIES) || [];
    var out = [];
    for (var i = 0; i < cats.length; i++) {
        var c = cats[i] || {};
        var subs = [];
        if (c.subs && c.subs.length) subs = c.subs;
        else if (c.subSubs) { for (var k in c.subSubs) { if (Object.prototype.hasOwnProperty.call(c.subSubs, k)) subs.push(k); } }
        out.push({ name: c.name, subs: subs, subSubs: c.subSubs || {} });
    }
    return out;
}

/* ---------- shop catalogue (#1, #40, #41, #42) ---------- */
/* A shop shows: platform/admin products + supplier products + THIS reseller's
   own products. Another reseller's own product is never returned (#40). */
function shopProducts(rid) {
    var ps = getData(DB_KEYS.PRODUCTS) || [];
    var out = [];
    /* 2026-09-18 — when the shop's premium/trial has lapsed, the reseller's OWN
       uploads disappear from the storefront (the customer sees the shared admin
       catalogue only). The product rows are NOT touched — they reappear the
       moment the reseller re-upgrades. */
    var reverted = !premiumShopOpen(rid);
    for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (!p) continue;
        if (productOwnerType(p) === 'reseller' && !isResellerOwnProduct(p, rid)) continue;  // tenant isolation
        if (reverted && productOwnerType(p) === 'reseller' && isResellerOwnProduct(p, rid)) continue;  // premium work hidden, not deleted
        out.push(p);
    }
    return out;
}
function shopVisibleProducts(rid) {
    var ps = shopProducts(rid), out = [];
    for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if ((p.stock || 0) <= 0) continue;
        if (p.supplierId && p.approved === false) continue;
        if (p.is_active === false) continue;
        if (!productVisibleInShop(rid, p)) continue;     // category switched OFF (#43)
        out.push(p);
    }
    return out;
}
/* My Shop search (Part 6/7) — Product Name OR SKU OR Category.
   Isolation is unchanged and still enforced by `shopVisibleProducts`, which is
   the ONE place that applies the shop visibility + ownership rules (stock,
   unapproved supplier product, is_active:false, category switched off, and the
   "never another reseller's own product" rule). Searching can therefore only
   ever return products this shop is already allowed to show — the filter is in
   the query, not bolted on in the UI.

   Matching is case-insensitive and partial, and covers:
     · product name
     · sku  (admin/reseller/supplier forms all store `sku`)
     · brand
     · category, subcategory, sub-subcategory — via `productCategoryChain()`,
       which walks the same 3-level hierarchy the rest of the app uses, so a
       search for a parent category ("Shirt") also finds products filed under
       one of its children.
   A multi-word query must match every word (any field), so "punjabi blue"
   narrows instead of widening. */
function shopSearch(rid, q) {
    var list = shopVisibleProducts(rid);
    q = String(q || '').toLowerCase().trim();
    if (!q) return list;

    /* one haystack per product, built from real DB fields only */
    var words = q.split(/\s+/).filter(function (w) { return w.length > 0; });
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var hay = [
            p.name,
            p.sku,
            p.brand,
            productCategoryChain(p),                       /* Category › Sub › Sub-Sub */
            p.category, p.cat,
            p.subSection, p.sub_category, p.subcategory,
            p.subSub, p.sub_sub, p.subSubCategory
        ].join(' ').toLowerCase();
        var hit = true;
        for (var w = 0; w < words.length; w++) {
            if (hay.indexOf(words[w]) === -1) { hit = false; break; }
        }
        if (hit) out.push(p);
    }
    return out;
}
/* Filter by the 3-level hierarchy (#42) */
function shopFilter(list, cat, sub, subsub) {
    /* shopFilter-normalised (2026-09-17, this request).
       The header shows the DEDUPED category name — for this shop that is
       "Men's Fashion" — while the products store the other spelling, "Men Fashion".
       The old comparison was an exact string match, so opening Men's Fashion from the
       header matched NOTHING and the customer saw an empty category. Gadget worked
       only because its two spellings happen to be identical.
       Every level is now compared with catDedupeKey(), the same normaliser the header
       uses, so "Men Fashion" / "Men's Fashion" / "mens fashion" are one category.
       Sub and sub-sub also get case/punctuation folded, so "T-Shirt" and "t shirt"
       match, and a trailing plural no longer hides a product. */
    var out = [];
    var wantCat = cat ? catDedupeKey(cat) : '';
    var wantSub = sub ? catDedupeKey(sub) : '';
    var wantSubSub = subsub ? catDedupeKey(subsub) : '';
    for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (wantCat && !catKeyMatch(p.category, cat)) continue;
        if (wantSub && !catKeyMatch((p.section || p.subSection || ''), sub)) continue;
        if (wantSubSub && !catKeyMatch(p.subSub, subsub)) continue;
        out.push(p);
    }
    return out;
}

/* ---------- My Shop orders (#14, #26, #27, #28, #50) ---------- */
function isMyShopOrder(o) {
    if (!o) return false;
    var s = String(o.source || o.order_source || '').toLowerCase();
    return s === 'myshop' || s === 'my_shop' || s === 'my-shop';
}

/* ---------------------------------------------------------------------------
   ORDER OWNERSHIP RESOLVER (single source of truth)
   ---------------------------------------------------------------------------
   An order's owning reseller is NOT reliably in one field. Depending on which
   page created it, the id may live in `resellerId`, `reseller_id` or `shop_id`
   — and in a My Shop the account id and the shop id can even differ. Matching
   on `o.resellerId` alone therefore made a real order invisible in the owner's
   own views (All Orders / My Shop Orders) even though the admin side still saw
   it. These helpers read EVERY ownership location, plus the per-line ownership
   of the order's own uploaded products, so an order can never fall out of its
   owner's list because one field happened to be named differently.
   --------------------------------------------------------------------------- */
/* Is `v` the same identity as reseller `rid` (loose, string-safe)? */
function sameResellerId(v, rid) {
    if (v === undefined || v === null || v === '') return false;
    if (rid === undefined || rid === null || rid === '') return false;
    return String(v) === String(rid);
}
/* TRUE when order `o` belongs to reseller `rid`, checked against every
   ownership field the order may carry. */
function orderBelongsToReseller(o, rid) {
    if (!o) return false;
    if (sameResellerId(o.resellerId, rid)) return true;
    if (sameResellerId(o.reseller_id, rid)) return true;
    if (sameResellerId(o.shop_id, rid)) return true;
    /* last resort: does it contain a product this reseller uploaded? */
    return orderHasOwnProduct(o, rid);
}
/* Which reseller owns this order (for display) — first field that is set. */
function orderOwnerId(o) {
    if (!o) return null;
    if (o.resellerId !== undefined && o.resellerId !== null && o.resellerId !== '') return o.resellerId;
    if (o.reseller_id !== undefined && o.reseller_id !== null && o.reseller_id !== '') return o.reseller_id;
    if (o.shop_id !== undefined && o.shop_id !== null && o.shop_id !== '') return o.shop_id;
    return null;
}
function myShopOrders() {
    var orders = getData(DB_KEYS.ORDERS) || [];
    var out = [];
    for (var i = 0; i < orders.length; i++) if (isMyShopOrder(orders[i])) out.push(orders[i]);
    return out;
}
function myShopOrdersOf(rid) {
    var orders = myShopOrders(), out = [];
    for (var i = 0; i < orders.length; i++) {
        if (orderBelongsToReseller(orders[i], rid)) out.push(orders[i]);
    }
    return out;
}
/* Normal platform orders = everything that is NOT a My Shop order (#27) */
function platformOrders() {
    var orders = getData(DB_KEYS.ORDERS) || [];
    var out = [];
    for (var i = 0; i < orders.length; i++) if (!isMyShopOrder(orders[i])) out.push(orders[i]);
    return out;
}
/* Does this order contain at least one of the reseller's OWN products? (#14) */
function orderHasOwnProduct(o, rid) {
    if (!o) return false;
    if (o.items && o.items.length) {
        for (var i = 0; i < o.items.length; i++) {
            var it = o.items[i] || {};
            if (it.product_owner_type === 'reseller' && sameResellerId(it.product_owner_id, rid)) return true;
            if (sameResellerId(it.ownerResellerId, rid)) return true;
            /* A line may carry only the shop id. `shop_id` is the BUYING shop —
               it is stamped on every line of an order placed in this reseller's
               shop, including the lines of ANOTHER reseller's product bought
               through her shop (see reseller/my-shop-product.html, which writes
               shop_id on all lines but ownerResellerId only when isOwn). It
               therefore must NOT, on its own, prove that the ORDER contains a
               product this reseller uploaded — otherwise a bought product would
               drag a foreign order into her My Shop Orders. Only use it when the
               line carries no opposing owner evidence. */
            var tLine = String(it.product_owner_type || it.product_source || '').toLowerCase();
            var lineOwner = (it.product_owner_id !== undefined && it.product_owner_id !== null && it.product_owner_id !== '') ? it.product_owner_id : it.ownerResellerId;
            if (tLine === 'reseller' && lineOwner === null) {
                if (sameResellerId(it.shop_id, rid)) return true;
            }
            var pr = findProductById(it.productId);
            if (pr && isResellerOwnProduct(pr, rid)) return true;
        }
        return false;
    }
    var p = findProductById(o.productId);
    return !!(p && isResellerOwnProduct(p, rid));
}
function findProductById(id) {
    var ps = getData(DB_KEYS.PRODUCTS) || [];
    for (var i = 0; i < ps.length; i++) if (String(ps[i].id) === String(id)) return ps[i];
    return null;
}
/* Order classification shown in the UI (#13, #50) */
function orderSourceLabel(o) {
    if (isMyShopOrder(o)) {
        var hasOwn = false;
        var rid = o.resellerId || o.shop_id;
        if (orderHasOwnProduct(o, rid)) hasOwn = true;
        return hasOwn ? 'My Shop Order — Own Product' : 'My Shop Order';
    }
    return 'Platform Order';
}

/* ---------- variant / product summary (#31) ---------- */
function orderItemCount(o) {
    var n = 0;
    if (o.items && o.items.length) { for (var i = 0; i < o.items.length; i++) n += (Number(o.items[i].qty) || 1); }
    else n = Number(o.qty) || 1;
    return n;
}
function orderVariantSummary(o) {
    var sizes = {}, colors = {}, others = {};
    var items = (o.items && o.items.length) ? o.items : [{ size: o.size, color: o.color, variant: o.variant, qty: o.qty || 1 }];
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {}, q = Number(it.qty) || 1;
        var sz = String(it.size || (it.sizeQty && it.sizeQty[0] && it.sizeQty[0].size) || '').trim();
        var cl = String(it.color || '').trim();
        var vr = String(it.variant || '').trim();
        if (sz) sizes[sz] = (sizes[sz] || 0) + q;
        if (cl) colors[cl] = (colors[cl] || 0) + q;
        if (vr) others[vr] = (others[vr] || 0) + q;
    }
    return { sizes: sizes, colors: colors, variants: others };
}
function orderProductCount(o) {
    if (o.items && o.items.length) return o.items.length;
    return o.productId ? 1 : 0;
}

/* ---------- pixel event de-duplication (#5) ----------
   Purchase (and any event you want) is keyed by event + order id, so a page
   refresh can never fire the same purchase twice. */
function pixelEventKey(rid) { return 'rh_pixel_events_' + String(rid); }
function pixelEventSent(rid, key) {
    try {
        var m = JSON.parse(localStorage.getItem(pixelEventKey(rid)) || '{}');
        return !!m[key];
    } catch (e) { return false; }
}
function markPixelEvent(rid, key) {
    try {
        var m = JSON.parse(localStorage.getItem(pixelEventKey(rid)) || '{}');
        m[key] = new Date().toISOString();
        localStorage.setItem(pixelEventKey(rid), JSON.stringify(m));
        return true;
    } catch (e) { return false; }
}

/* ---------- custom domain (#8 - #11) ---------- */
function normaliseDomain(v) {
    var d = String(v || '').trim().toLowerCase();
    d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (d.indexOf('www.') === 0) d = d.substring(4);
    return d;
}
function shopDomainToken(rid) {
    var s = getShopSettings(rid);
    if (s.domain && s.domain.token) return s.domain.token;
    var t = 'rhbd-verify-' + String(rid) + '-' + Math.random().toString(36).substring(2, 10);
    patchShopSettings(rid, { domain: { token: t } });
    return t;
}
/* Resolve a reseller id from a custom domain (#11). Returns null when unmapped. */
function findShopByDomain(domain) {
    var d = normaliseDomain(domain);
    if (!d) return null;
    var all = getAllShopSettings();
    for (var rid in all) {
        if (!Object.prototype.hasOwnProperty.call(all, rid)) continue;
        var s = all[rid];
        if (!s || !s.domain) continue;
        if (normaliseDomain(s.domain.name) === d && s.domain.status === 'active') return rid;
    }
    return null;
}

/* ---------- My Shop dashboard summary (#46) ---------- */
function shopSummary(rid) {
    var settings = getShopSettings(rid);
    var all = shopProducts(rid);
    var own = 0;
    for (var i = 0; i < all.length; i++) if (isResellerOwnProduct(all[i], rid)) own++;
    var orders = myShopOrdersOf(rid);
    var pending = 0, delivered = 0, sales = 0;
    for (var j = 0; j < orders.length; j++) {
        var st = String(orders[j].status || '').toLowerCase();
        if (st === 'delivered') { delivered++; sales += Number(orders[j].amount) || 0; }
        else if (st === 'cancel' || st === 'cancelled' || st === 'returned' || st === 'rejected') { /* not pending */ }
        else pending++;
    }
    var px = settings.pixels || {};
    var connected = [];
    if (px.meta && px.meta.connected) connected.push('Meta');
    if (px.tiktok && px.tiktok.connected) connected.push('TikTok');
    if (px.instagram && px.instagram.connected) connected.push('Instagram');
    return {
        enabled: settings.enabled !== false,
        shopUrl: 'my-shop.html?rid=' + rid,
        domain: settings.domain || { name: '', status: 'none' },
        totalProducts: all.length,
        ownProducts: own,
        orders: orders.length,
        pending: pending,
        delivered: delivered,
        sales: sales,
        pixels: connected
    };
}

/* ==========================================================================
   MY SHOP — PIXEL TRACKING (#3 - #7)
   --------------------------------------------------------------------------
   * Only the pixels belonging to THIS reseller (rid) are ever loaded.
   * Standard e-commerce events: PageView, ViewContent, Search, AddToCart,
     InitiateCheckout, AddPaymentInfo, Purchase.
   * Purchase is de-duplicated per order id — a refresh can never fire twice.
   * Optional server-side relay (capiEndpoint) keeps credentials off the
     browser; when it is empty only the official browser pixels are used.
   ========================================================================== */

var SHOP_PIXEL_LOADED = { rid: null, meta: '', tiktok: '', instagram: '' };

function shopPixelCfg(rid) { return getShopSettings(rid).pixels || {}; }

function shopPixelLoadScript(src, id) {
    try {
        if (document.getElementById(id)) return;
        var s = document.createElement('script');
        s.id = id; s.async = true; s.src = src;
        document.head.appendChild(s);
    } catch (e) {}
}

/* Load + init the vendor queues. Called once per page, per shop. */
function shopPixelInit(rid) {
    if (!rid) return;
    var px = shopPixelCfg(rid);
    var metaId = (px.meta && px.meta.connected && px.meta.id) ? px.meta.id : '';
    var igId = (px.instagram && px.instagram.connected && px.instagram.id) ? px.instagram.id : '';
    var ttId = (px.tiktok && px.tiktok.connected && px.tiktok.id) ? px.tiktok.id : '';

    /* ---- Meta (Facebook + Instagram are both Meta-owned) ---- */
    if (metaId || igId) {
        try {
            if (!window.fbq) {
                (function (f, b, e, v, n, t, s) {
                    if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
                    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
                    t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
                })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
            }
            var ids = [];
            if (metaId) ids.push(metaId);
            if (igId && ids.indexOf(igId) === -1) ids.push(igId);
            for (var i = 0; i < ids.length; i++) {
                try { window.fbq('init', ids[i]); } catch (e) {}
            }
            SHOP_PIXEL_LOADED.meta = metaId;
            SHOP_PIXEL_LOADED.instagram = igId;
        } catch (e) {}
    }

    /* ---- TikTok ---- */
    if (ttId) {
        try {
            if (!window.ttq) {
                (function (w, d, t) {
                    w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || [];
                    ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie'];
                    ttq.setAndDefer = function (t2, e2) { t2[e2] = function () { t2.push([e2].concat(Array.prototype.slice.call(arguments, 0))); }; };
                    for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
                    ttq.load = function (e2) { var s = d.createElement('script'); s.async = !0; s.src = 'https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=' + e2 + '&lib=' + t; var x = d.getElementsByTagName('script')[0]; x.parentNode.insertBefore(s, x); };
                })(window, document, 'ttq');
            }
            try { window.ttq.load(ttId); window.ttq('page'); } catch (e) {}
            SHOP_PIXEL_LOADED.tiktok = ttId;
        } catch (e) {}
    }

    SHOP_PIXEL_LOADED.rid = String(rid);
    shopPixelTrack(rid, 'PageView', {}, 'pageview:' + String(location.pathname));
}

/* Fire an event on every connected platform.
   dedupeKey: when given, the event is recorded once and never repeated. */
function shopPixelTrack(rid, name, params, dedupeKey) {
    if (!rid) return false;
    params = params || {};
    if (dedupeKey) {
        if (pixelEventSent(rid, dedupeKey)) return false;   /* (#5) no duplicates */
        markPixelEvent(rid, dedupeKey);
    }
    var px = shopPixelCfg(rid);

    try {
        if ((px.meta && px.meta.connected) || (px.instagram && px.instagram.connected)) {
            if (typeof window.fbq === 'function') {
                try { window.fbq('track', name, params); } catch (e) {}
                try { window.fbq('trackCustom', name, params); } catch (e) {}
            }
        }
    } catch (e) {}
    try {
        if (px.tiktok && px.tiktok.connected && typeof window.ttq === 'function') {
            var ttName = name;
            if (name === 'ViewContent') ttName = 'ViewContent';
            else if (name === 'AddToCart') ttName = 'AddToCart';
            else if (name === 'InitiateCheckout') ttName = 'InitiateCheckout';
            else if (name === 'Purchase') ttName = 'CompletePayment';
            else if (name === 'Search') ttName = 'Search';
            else if (name === 'AddPaymentInfo') ttName = 'AddPaymentInfo';
            window.ttq('track', ttName, params);
        }
    } catch (e) {}

    /* optional server-side relay — credentials stay on the server */
    try {
        if (px.capiEndpoint) {
            fetch(px.capiEndpoint, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reseller_id: String(rid), event: name, params: params, ts: new Date().toISOString() })
            }).catch(function () {});
        }
    } catch (e) {}
    return true;
}

/* Build a standard contents array for an order (#4, #5) */
function shopPixelOrderContents(o) {
    var items = (o && o.items && o.items.length) ? o.items : [{ productId: o && o.productId, name: o && o.productName, qty: (o && o.qty) || 1, price: o && o.productPrice, category: o && o.category, variant: o && o.variant }];
    var out = [];
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        out.push({
            id: String(it.productId || ''),
            product_id: String(it.productId || ''),
            name: it.name || '',
            quantity: Number(it.qty) || 1,
            item_price: Number(it.price) || 0,
            category: it.category || '',
            variant: it.variant || it.size || it.color || ''
        });
    }
    return out;
}
function shopPixelPurchasePayload(o) {
    return {
        order_id: String(o.id),
        value: Number(o.amount) || 0,
        currency: 'BDT',
        content_type: 'product',
        contents: shopPixelOrderContents(o),
        num_items: orderItemCount(o)
    };
}

/* ==========================================================================
   SUPPLIER SHIPPING PIPELINE
   Order -> Packaging -> Ready to Ship -> Steadfast (Admin credentials)
         -> real Parcel/Consignment ID -> Print
   --------------------------------------------------------------------------
   Security: the Steadfast API key/secret are NEVER read into frontend code
   here. Every call goes through the Admin-configured backend proxy
   (`settings.sf_proxy` -> backend/steadfast-proxy.php). If no proxy is
   configured the action fails loudly instead of leaking credentials.
   ========================================================================== */

/* Shop ID printed on every label (fixed by the spec). */
var SHIP_SHOP_ID = 'OGIQVRWD';

/* ---------- Steadfast backend bridge (proxy only — no keys in the browser) ---------- */
function sfProxyUrl() {
    try { var s = getOne(DB_KEYS.SETTINGS); return String(s.sf_proxy || '').trim(); } catch (e) { return ''; }
}
function sfBackendReady() { return !!sfProxyUrl(); }
/* action = 'create' | 'fraud'. cb(err, json) */
function sfBackendCall(action, body, cb) {
    var px = sfProxyUrl();
    if (!px) { cb(new Error('NO_PROXY')); return; }
    var payload = { action: action };
    for (var k in body) { if (Object.prototype.hasOwnProperty.call(body, k)) payload[k] = body[k]; }
    try {
        fetch(px, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (j) { cb(null, j); })
            .catch(function (e) { cb(e); });
    } catch (e) { cb(e); }
}
function sfBackendCreate(order, cb) { sfBackendCall('create', { order: order }, cb); }
function sfBackendFraud(phone, cb) { sfBackendCall('fraud', { phone: phone }, cb); }

/* ---------- ownership (#28) ----------
   A supplier may only ever act on an order that actually contains one of
   THEIR products. Returns true/false — callers must refuse otherwise. */
function supplierOwnsOrder(o, supplierId) {
    if (!o) return false;
    var ps = getData(DB_KEYS.PRODUCTS) || [], mine = {};
    for (var i = 0; i < ps.length; i++) {
        if (String(ps[i].supplierId) === String(supplierId)) mine[String(ps[i].id)] = true;
    }
    if (o.items && o.items.length) {
        for (var j = 0; j < o.items.length; j++) {
            var it = o.items[j] || {};
            if (String(it.supplierId) === String(supplierId)) return true;
            if (mine[String(it.productId)]) return true;
        }
        return false;
    }
    if (o.productId && mine[String(o.productId)]) return true;
    return false;
}

/* ---------- shipping state machine (#25, #26) ----------
   none -> packaging -> ready_to_ship -> steadfast_created
   Print is allowed ONLY in the final state. */
function shipStageOf(o, supplierId) {
    if (!o) return 'none';
    var ss = String(o.shipping_status || '');
    if (ss === 'steadfast_created' || o.steadfast_consignment_id || o.steadfast_parcel_id) return 'steadfast_created';
    if (ss === 'ready_to_ship') return 'ready_to_ship';
    if (ss === 'packaging') return 'packaging';
    /* legacy records created by the old readyShip()/markShipped() flow */
    if (o.shipFlags && o.shipFlags[String(supplierId)]) return 'ready_to_ship';
    if (String(o.status || '') === 'packaging') return 'packaging';
    return 'none';
}
function shipParcelId(o) {
    if (!o) return '';
    return String(o.steadfast_parcel_id || o.steadfast_consignment_id || o.consignment_id || '');
}
/* (#6, #26) Print gate — the single source of truth for the Print button. */
/* 2026-09-19 (this request) — an ADMIN-DISPATCHED order is printable too.
   The user: "যদি কোনো অর্ডার অ্যাডমিনের তরফ থেকে শিপিংয়ে দিয়ে দেওয়া হয়
   সেক্ষেত্রে সাপ্লায়ার চাইলে ওই অর্ডারটা প্রিন্ট আউট বের করতে পারবে।"

   WHY this was impossible before: the admin's status dropdown (admin/orders.html)
   writes ONLY `o.status`. It never sets `shipping_status`, so shipStageOf()
   returned 'none' and the supplier's action cell rendered the locked placeholder
   — no Print button, in any form. Measured: status 'shipping'/'shipped' with no
   shipping_status -> stage 'none' -> canPrint false.

   The gate now also accepts an order that has genuinely MOVED INTO a shipping
   stage, even though no Steadfast parcel exists. That is the whole point of the
   request: the admin dispatched it, so the supplier needs the packing slip.

   Deliberately NARROW so it cannot open the gate for work the supplier does
   itself:
     · the stage must be one of the three POST-dispatch stages — 'shipping',
       'in_transit', 'delivered' — i.e. the parcel has left. A 'confirmed' or
       'packaging' order is NOT printable, which keeps the existing rule that
       Print appears only after the order moved on.
     · 'cancelled' / 'returned' / the failed-delivery family are NOT in the list,
       so a dead parcel stays unprintable.
     · a Multi-Supplier order is refused, because the platform collects it.
     · an order sitting at shipStage 'ready_to_ship' is refused. That state means
       the SUPPLIER pressed Ready to Ship and the Steadfast call FAILED — its
       action cell correctly shows "Retry Steadfast", and offering Print there
       would contradict the screen (and would print a slip for a parcel that was
       never booked).
   A real Steadfast parcel keeps the original answer exactly as it was. */
var ADMIN_DISPATCH_PRINTABLE = { 'shipping': 1, 'in_transit': 1, 'delivered': 1 };
function shipCanPrint(o, supplierId) {
    if (!o) return false;
    var stage = shipStageOf(o, supplierId);
    /* the original, unchanged rule — a real Steadfast booking */
    if (stage === 'steadfast_created' && !!shipParcelId(o)) return true;
    /* the admin-dispatched case */
    if (stage === 'ready_to_ship') return false;   /* supplier's own failed attempt */
    if (typeof isMultiSupplierOrder === 'function' && isMultiSupplierOrder(o)) return false;
    var k = String(o.status === undefined || o.status === null ? '' : o.status).toLowerCase().trim();
    if (typeof orderStageKey === 'function') { try { k = orderStageKey(k); } catch (e) {} }
    return !!ADMIN_DISPATCH_PRINTABLE[k];
}
function shipStageLabel(stage) {
    if (stage === 'packaging') return 'Packaging';
    if (stage === 'ready_to_ship') return 'Ready to Ship';
    if (stage === 'steadfast_created') return 'Ready to Ship';
    return 'Pending';
}

/* ---------- mutations ---------- */
function findOrderById(oid) {
    var orders = getData(DB_KEYS.ORDERS) || [];
    for (var i = 0; i < orders.length; i++) { if (String(orders[i].id) === String(oid)) return orders[i]; }
    return null;
}
/* (#2) Packaging — no Steadfast call, no Parcel ID, no Print. */
function setOrderPackaging(oid, supplierId) {
    var orders = getData(DB_KEYS.ORDERS) || [], done = false;
    for (var i = 0; i < orders.length; i++) {
        if (String(orders[i].id) !== String(oid)) continue;
        orders[i].shipping_status = 'packaging';
        orders[i].packaging_at = new Date().toISOString();
        if (orders[i].status === 'new' || orders[i].status === 'pending' || orders[i].status === 'confirmed') orders[i].status = 'packaging';
        done = true;
        break;
    }
    if (done) setData(DB_KEYS.ORDERS, orders);
    return done;
}
/* (#3) Mark Ready to Ship — called BEFORE the Steadfast request so a failure
   is recoverable and never looks like success. */
function setOrderReadyToShip(oid, supplierId) {
    var orders = getData(DB_KEYS.ORDERS) || [], done = false;
    for (var i = 0; i < orders.length; i++) {
        if (String(orders[i].id) !== String(oid)) continue;
        orders[i].shipping_status = 'ready_to_ship';
        orders[i].ready_to_ship_at = new Date().toISOString();
        done = true;
        break;
    }
    if (done) setData(DB_KEYS.ORDERS, orders);
    return done;
}
/* (#3, #25) Persist the REAL Steadfast identifiers returned by the API. */
function saveSteadfastShipment(oid, supplierId, res) {
    var c = (res && res.consignment) ? res.consignment : (res || {});
    var consignment = String(c.consignment_id || c.consignmentId || (res && res.consignment_id) || '');
    var tracking = String(c.tracking_code || c.trackingCode || (res && res.tracking_code) || '');
    var parcel = String(c.parcel_id || c.parcelId || (res && res.parcel_id) || consignment || '');
    var shipment = String(c.id || c.shipment_id || (res && res.shipment_id) || consignment || '');
    if (!consignment && !parcel) return null;

    var orders = getData(DB_KEYS.ORDERS) || [], updated = null;
    for (var i = 0; i < orders.length; i++) {
        if (String(orders[i].id) !== String(oid)) continue;
        var o = orders[i];
        o.shipping_status = 'steadfast_created';
        o.steadfast_consignment_id = consignment;
        o.steadfast_parcel_id = parcel;
        o.steadfast_shipment_id = shipment;
        o.steadfast_tracking_code = tracking;
        o.steadfast_created_at = new Date().toISOString();
        try { o.steadfast_response = JSON.stringify(res).substring(0, 4000); } catch (e) { o.steadfast_response = ''; }
        /* keep the legacy shape in sync so existing admin views still work */
        o.consignment_id = consignment;
        if (!o.shipFlags) o.shipFlags = {};
        o.shipFlags[String(supplierId)] = true;
        if (!o.courierEntries) o.courierEntries = [];
        var found = false;
        for (var k = 0; k < o.courierEntries.length; k++) {
            if (String(o.courierEntries[k].supplierId) === String(supplierId)) { o.courierEntries[k].consignment = consignment; found = true; break; }
        }
        if (!found) {
            o.courierEntries.push({
                supplierId: supplierId, supplierName: '', pickup: '', delivery: '',
                time: new Date().toISOString(), consignment: consignment,
                invoiceNo: 'SS' + String(oid).replace(/[^0-9]/g, ''), source: 'steadfast'
            });
        }
        if (o.status === 'new' || o.status === 'pending' || o.status === 'confirmed' || o.status === 'packaging') o.status = 'shipped';
        updated = o;
        break;
    }
    if (updated) setData(DB_KEYS.ORDERS, orders);
    return updated;
}
function logSteadfastFailure(oid, supplierId, err, res) {
    try {
        logActivity('steadfast_failed', 'Steadfast shipment failed for order ' + oid + ' (supplier #' + supplierId + '): ' + (err ? (err.message || err) : JSON.stringify(res || {})));
    } catch (e) {}
}
/* (#25) remember which format was printed */
function markOrderPrinted(oid, format) {
    var orders = getData(DB_KEYS.ORDERS) || [];
    for (var i = 0; i < orders.length; i++) {
        if (String(orders[i].id) !== String(oid)) continue;
        orders[i].printed_at = new Date().toISOString();
        orders[i].print_format = format || '';
        break;
    }
    setData(DB_KEYS.ORDERS, orders);
}

/* ---------- print payload (#8 - #16) ----------
   ONLY: product name, quantity, price, Parcel ID, Shop ID, thank-you text.
   No customer / supplier / cost / profit / payment information. */
/* The RETAIL (খুচরা) price of one line — the price the product is listed at
   for the customer, i.e. the supplier's / platform's own selling price.
   NEVER the reseller's marked-up price and never the cost/buying price. */
function shipLineRetail(it) {
    if (!it) return 0;
    var p = findProductById(it.productId !== undefined && it.productId !== null ? it.productId : it.product_id);
    var v = it.retail_price;
    if (v !== undefined && v !== null && v !== '' && Number(v)) return Number(v) || 0;
    if (p) {
        var pv = p.customer_price;
        if (pv !== undefined && pv !== null && pv !== '' && Number(pv)) return Number(pv) || 0;
        pv = p.price;
        if (pv !== undefined && pv !== null && pv !== '' && Number(pv)) return Number(pv) || 0;
    }
    if (it.customer_price !== undefined && it.customer_price !== null && Number(it.customer_price)) return Number(it.customer_price) || 0;
    return Number(it.price) || 0;
}
/* The price the RESELLER actually charged the customer (itemSellingPrice is
   the historical customer-facing price captured at checkout). */
function shipLineResale(it) { return itemSellingPrice(it); }

function shipPrintItems(o, supplierId) {
    var items = [];
    if (o && o.items && o.items.length) {
        var ps = getData(DB_KEYS.PRODUCTS) || [], mine = {};
        for (var i = 0; i < ps.length; i++) {
            if (String(ps[i].supplierId) === String(supplierId)) mine[String(ps[i].id)] = true;
        }
        for (var j = 0; j < o.items.length; j++) {
            var it = o.items[j] || {};
            var isMine = (typeof orderItemIsSupplier === 'function')
                ? orderItemIsSupplier(it, supplierId)
                : (String(it.supplierId) === String(supplierId) || mine[String(it.productId)]);
            if (!isMine) continue;
            var qty = Number(it.qty) || 1;
            /* 2026-09-18 — LINE FIRST. shipLineRetail() consults the PRODUCT record
               before the line's own resale/selling_price, so a product whose price
               was edited after the order was placed changed an already-printed
               invoice. rhInvLinePrice() uses the price frozen on the order line. */
            var retail = rhInvLinePrice(it);
            var resale = shipLineResale(it);
            items.push({
                name: String(it.name || 'Product'),
                qty: qty,
                price: resale,
                retail: retail,
                resale: resale,
                lineRetail: retail * qty,
                lineResale: resale * qty,
                /* 2026-09-18 — the unified invoice sheet needs the product's own
                   picture and code; both are resolved here so every caller gets
                   them without a second lookup. */
                productId: (it.productId === undefined || it.productId === null) ? '' : it.productId,
                image: rhInvLineImage(it),
                sku: rhInvLineSku(it),
                variant: [it.size, it.color, it.variant].filter(function (x) { return !!x; }).join(' / ')
            });
        }
    } else if (o) {
        var q1 = Number(o.qty) || 1;
        var r1 = shipLineRetail({ productId: o.productId, price: o.productPrice });
        var s1 = shipLineResale({ selling_price: o.selling_price, resale: o.resale, customer_price: o.customer_price, price: o.productPrice });
        items.push({
            name: String(o.productName || 'Product'), qty: q1, price: s1, retail: r1, resale: s1,
            lineRetail: r1 * q1, lineResale: s1 * q1,
            productId: (o.productId === undefined || o.productId === null) ? '' : o.productId,
            image: rhInvLineImage({ productId: o.productId, image: o.image }),
            sku: rhInvLineSku({ productId: o.productId, sku: o.sku }),
            variant: [o.size, o.color].filter(function (x) { return !!x; }).join(' / ')
        });
    }
    return items;
}
function shipPrintData(o, supplierId) {
    var items = shipPrintItems(o, supplierId);
    var total = 0, qty = 0, resaleTotal = 0;
    for (var i = 0; i < items.length; i++) {
        total += items[i].resale * items[i].qty;
        resaleTotal += items[i].lineResale;
        qty += items[i].qty;
    }
    /* The delivery charge the customer pays on top. Stored on the order. */
    var delivery = (typeof orderDeliveryCharge === 'function') ? orderDeliveryCharge(o) : (Number(o && o.shippingCharge) || 0);
    var payable = resaleTotal + delivery;
    return {
        orderId: o ? String(o.id) : '',
        items: items,
        totalQty: qty,
        totalAmount: total,
        parcelId: shipParcelId(o),
        consignmentId: String((o && (o.steadfast_consignment_id || o.consignment_id || o.consignmentId)) || '') || shipParcelId(o),
        shopId: (typeof shipShopId === 'function') ? shipShopId() : SHIP_SHOP_ID,
        productTotal: resaleTotal,
        deliveryCharge: delivery,
        totalPayable: payable,
        thankYou: 'Thank You',
        thankYouSub: ''
    };
}

/* ==========================================================================
   UNIFIED INVOICE SHEET (2026-09-18 — this request)
   --------------------------------------------------------------------------
   ONE builder for all three print paths, so the sheet can never drift:
     · supplier panel    -> shipLabelHtml(a4 | a5)
     · admin All Orders  -> adminOrderPrintSheet(a4 | a5)
     · admin Multi-Sup   -> multiSupplierInvoiceSheet(a4 | a5)
   The compact labels (3x2 / 3x3 / 2x3) keep their EXISTING layout — nothing
   about them changes.

   Field rules confirmed with the user:
     · DATE            = the order's own date (o.date), YYYY-MM-DD
     · CUSTOMER PHONE  = masked: six asterisks + the LAST FOUR digits
     · STATUS          = always "Shipping" (not the stored status)
     · PRICE           = what the CUSTOMER pays (retail) — never the resale
     · DELIVERY CHARGE = the order's own charge, applied ONCE (not per line)
     · TOTAL           = item lines + delivery charge
     · CONSIGNMENT     = the real courier consignment id, "—" until booked
     · SHOP ID         = admin Settings -> Shop ID (shipShopId())
     · RESELLER BLOCK  = admin sheets ONLY: brand name, mobile, address, gmail
   ========================================================================== */
function rhInvEsc(v) {
    return String(v === undefined || v === null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function rhInvMoney(n) { return '&#2547;' + (Number(n) || 0).toLocaleString('en-IN'); }
/* Six asterisks + the last four digits, exactly as in the reference sheet. */
function rhInvMaskPhone(p) {
    var s = String(p === undefined || p === null ? '' : p).replace(/[^0-9]/g, '');
    if (!s) return '';
    if (s.length <= 4) return s;
    return '******' + s.slice(-4);
}
/* The CUSTOMER price of one line.
   ORDER MATTERS: the price FROZEN on the order line wins over the product
   record, because the product may have been edited (or its price changed) since
   the order was placed — an already-printed invoice must never move. Only when
   the line carries no price at all do we fall back to the product. */
function rhInvLinePrice(it) {
    if (!it) return 0;
    var n = function (v) { return (v === undefined || v === null || v === '' || isNaN(Number(v))) ? null : Number(v); };
    if (it.retail !== undefined && it.retail !== null && Number(it.retail)) return Number(it.retail);
    var own = n(it.selling_price);
    if (own === null) own = n(it.resale);
    if (own === null) own = n(it.customer_price);
    if (own === null) own = n(it.retail_price);
    if (own !== null) return own;
    var r = 0;
    try { r = shipLineRetail(it); } catch (e) { r = 0; }
    if (Number(r)) return Number(r);
    return Number(it.price) || 0;
}
function rhInvLineImage(it) {
    var raw = (it && (it.image || it.img || it.thumb)) || '';
    if (!raw && it && it.productId !== undefined && it.productId !== null) {
        var p = (typeof findProductById === 'function') ? findProductById(it.productId) : null;
        if (p) raw = p.image || p.img || '';
    }
    try { return prodImgSrc(raw) || ''; } catch (e) { return ''; }
}
function rhInvLineSku(it) {
    if (it && it.sku) return String(it.sku);
    if (it && it.productId !== undefined && it.productId !== null) {
        var p = (typeof findProductById === 'function') ? findProductById(it.productId) : null;
        if (p && p.sku) return String(p.sku);
    }
    return '';
}
function rhInvItems(list) {
    var out = [];
    list = list || [];
    for (var i = 0; i < list.length; i++) {
        var it = list[i] || {};
        var qty = Number(it.qty) || 1;
        var price = rhInvLinePrice(it);
        var variant = it.variant ||
            [it.size, it.color].filter(function (x) { return !!x; }).join(' / ');
        out.push({
            name: String(it.name || 'Product'),
            qty: qty,
            price: price,
            line: price * qty,
            sku: rhInvLineSku(it),
            variant: String(variant || ''),
            image: rhInvLineImage(it)
        });
    }
    return out;
}
/* One normalised record for the sheet. `opts` lets a caller that already holds
   a supplier GROUP (the multi-supplier page) pass its own items / totals in. */
function rhInvData(o, opts) {
    opts = opts || {};
    var mode = (opts.mode === 'admin') ? 'admin' : 'supplier';
    var items = rhInvItems(opts.items && opts.items.length ? opts.items : ((o && o.items) || []));
    /* legacy single-product orders carry no items[] — but only synthesise a line
       when the order actually names a product. Without this guard an order with
       no lines at all produced a phantom "Product / ৳0" row, which reads as a
       real (wrong) charge instead of the honest placeholder. */
    if (!items.length && o && (o.productName || o.productId || o.productPrice)) {
        items = rhInvItems([{
            name: o.productName, qty: o.qty, productId: o.productId,
            price: o.productPrice || o.resale, size: o.size, color: o.color
        }]);
    }
    var productTotal = 0, qtyTotal = 0;
    for (var i = 0; i < items.length; i++) { productTotal += items[i].line; qtyTotal += items[i].qty; }

    var delivery = Number(opts.deliveryCharge);
    if (isNaN(delivery)) {
        delivery = (typeof orderDeliveryCharge === 'function')
            ? Number(orderDeliveryCharge(o) || 0)
            : Number(o && (o.shippingCharge !== undefined ? o.shippingCharge : o.deliveryCharge)) || 0;
    }
    var stored = Number(o && o.amount);
    var total = Number(opts.totalPayable);
    if (isNaN(total)) {
        /* TOTAL — two different questions, two different answers:
           · WHOLE order (supplier sheet, admin All Orders sheet): print the
             order's OWN stored amount. That is the number the customer actually
             owes and the number the admin already trusts; checkout builds it as
             items + delivery, so it also adds up on the page.
           · SUBSET (the multi-supplier page prints ONE supplier's lines): the
             order's amount would bill that supplier for items they do not
             supply, so the subset's own lines + the delivery charge are used. */
        if (!opts.subset && o && o.amount !== undefined && o.amount !== null && !isNaN(stored) && stored > 0) {
            total = stored;
        } else {
            total = productTotal + delivery;
        }
    }
    var cons = String(opts.consignmentId || '').trim();
    if (!cons) {
        /* The CONSIGNMENT box must show a CONSIGNMENT id — nothing else.
           adminOrderParcelId() is a PARCEL-first resolver, so using it here put
           the parcel id in the consignment box; and falling back to it at all
           would contradict the confirmed rule that the box stays BLANK until the
           courier booking actually exists. Prefer the consignment fields, then
           stop. */
        cons = String((o && (o.steadfast_consignment_id || o.consignment_id || o.consignmentId || o.consignment)) || '').trim();
    }
    /* The CONSIGNMENT box shows a CONSIGNMENT id and nothing else — confirmed
       rule: no other number may appear there, and the box stays BLANK (—) until
       the courier booking actually exists. adminOrderParcelId() is a PARCEL-first
       resolver, so it must never be used as a fallback here.
       `parcelId` is still computed for callers that want it, but the sheet does
       NOT print it (an earlier draft showed it as a sub-line; that was removed). */
    var parcel = (typeof shipParcelId === 'function') ? String(shipParcelId(o) || '') : '';
    if (!parcel && typeof adminOrderParcelId === 'function') parcel = String(adminOrderParcelId(o) || '');
    if (parcel && parcel === cons) parcel = '';

    var reseller = null;
    if (mode === 'admin') {
        reseller = (typeof adminOrderResellerInfo === 'function') ? adminOrderResellerInfo(o) : null;
        if (reseller) {
            /* the 4th line the user asked for — the reseller's Gmail */
            var email = '';
            try {
                var list = getData(DB_KEYS.RESELLERS) || [], rid = o ? o.resellerId : null;
                for (var k = 0; k < list.length; k++) {
                    if (String(list[k].id) === String(rid)) { email = String(list[k].email || list[k].gmail || ''); break; }
                }
            } catch (e) { }
            reseller = {
                name: String(reseller.name || ''),
                phone: String(reseller.phone || ''),
                address: String(reseller.address || ''),
                email: email
            };
        }
    }
    return {
        orderId: o ? String(o.id || '') : '',
        date: String(opts.date || (o && o.date) || '').slice(0, 10),
        phone: rhInvMaskPhone(o && (o.phone || o.customerPhone)),
        status: 'Shipping',
        items: items,
        productTotal: productTotal,
        totalQty: qtyTotal,
        deliveryCharge: delivery,
        totalPayable: total,
        /* Whatever the order charges beyond the printed lines + delivery — a COD
           fee, a discount, a legacy manual adjustment. Checkout builds `amount`
           as items + delivery, so this is 0 for a normal order and NO row is
           drawn. When it is not 0 the sheet would otherwise not add up, and a
           sheet whose numbers do not add up is read as a bug. */
        otherCharges: Math.round(total - (productTotal + delivery)),
        consignmentId: cons,
        parcelId: parcel,
        shopId: String(opts.shopId || (typeof shipShopId === 'function' ? shipShopId() : '') || ''),
        title: String(opts.title || ''),
        subtitle: String(opts.subtitle || ''),
        reseller: reseller
    };
}

/* The A4 / A5 sheet. Everything is sized in `em` off the wrapper, so A5 is the
   same design at 82% instead of a second hand-maintained layout. */
function rhInvSheet(d, format, opts) {
    opts = opts || {};
    var small = (format === 'a5');
    var admin = !!(d.reseller);

    var rows = '';
    for (var i = 0; i < d.items.length; i++) {
        var it = d.items[i];
        rows += '<tr>' +
            '<td class="n">' + (i + 1) + '</td>' +
            '<td class="p"><div class="prow">' +
                (it.image
                    ? '<img class="pimg" src="' + rhInvEsc(it.image) + '" alt="">'
                    : '<span class="pimg ph"><i class="fas fa-box"></i></span>') +
                '<span class="pmeta">' +
                    '<span class="pname">' + rhInvEsc(it.name) + '</span>' +
                    (it.sku ? '<span class="psku">(' + rhInvEsc(it.sku) + ')</span>' : '') +
                    '<span class="pvar">' + rhInvEsc(it.variant || 'Default / Default') + '</span>' +
                '</span>' +
            '</div></td>' +
            '<td class="c price">' + rhInvMoney(it.price) + '</td>' +
            '<td class="c qty">' + rhInvEsc(it.qty) + '</td>' +
            '</tr>';
    }
    if (!rows) rows = '<tr><td class="n">1</td><td class="p"><div class="prow"><span class="pimg ph"><i class="fas fa-box"></i></span><span class="pmeta"><span class="pname">Order items</span><span class="pvar">Default / Default</span></span></div></td><td class="c price">&mdash;</td><td class="c qty">&mdash;</td></tr>';

    var resBlock = '';
    if (admin && d.reseller) {
        resBlock =
            '<div class="rhi-res">' +
            '<div class="rhi-rest"><i class="fas fa-user-tie"></i> RESELLER DETAILS</div>' +
            '<div class="rhi-resg">' +
            '<div><span>BRAND NAME</span><b>' + rhInvEsc(d.reseller.name || '\u2014') + '</b></div>' +
            '<div><span>MOBILE</span><b>' + rhInvEsc(d.reseller.phone || '\u2014') + '</b></div>' +
            '<div class="wide"><span>ADDRESS</span><b>' + rhInvEsc(d.reseller.address || '\u2014') + '</b></div>' +
            '<div class="wide"><span>GMAIL</span><b>' + rhInvEsc(d.reseller.email || '\u2014') + '</b></div>' +
            '</div></div>';
    }

    var headName = d.title ? '<div class="rhi-sub">' + rhInvEsc(d.title) + '</div>' : '';

    return '<div class="rhi' + (small ? ' a5' : '') + '">' +
        '<span class="rhi-wave"></span>' +
        '<div class="rhi-head">' +
            '<div class="rhi-hl"><span class="rhi-logo"><i class="fas fa-truck-fast"></i></span>' +
            '<span class="rhi-inv">INVOICE</span></div>' +
            '<div class="rhi-hr">' +
                '<div class="rhi-ty">Thank You <i class="fas fa-heart"></i></div>' +
                '<div class="rhi-tys">for your trust and support</div>' +
            '</div>' +
        '</div>' + headName +
        '<div class="rhi-bar">' +
            '<div class="rhi-cell"><i class="fas fa-calendar-days"></i>' +
                '<span><span class="k">DATE</span><span class="v">' + rhInvEsc(d.date || '\u2014') + '</span></span></div>' +
            '<div class="rhi-cell"><i class="fas fa-phone"></i>' +
                '<span><span class="k">CUSTOMER PHONE</span><span class="v">' + rhInvEsc(d.phone || '\u2014') + '</span></span></div>' +
            '<div class="rhi-cell"><i class="fas fa-circle-check ok"></i>' +
                '<span><span class="k">STATUS</span><span class="v"><em class="rhi-pill">' + rhInvEsc(d.status) + '</em></span></span></div>' +
        '</div>' +
        '<div class="rhi-sec"><i class="fas fa-cube"></i> PRODUCTS<span class="rhi-line"></span></div>' +
        '<table class="rhi-tbl">' +
            '<thead><tr><th class="n">#</th><th>PRODUCT</th><th class="c">PRICE</th><th class="c">QTY</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
        '</table>' +
        '<div class="rhi-sum">' +
            '<div class="rhi-row"><i class="fas fa-truck"></i><span>Delivery Charge</span><b>' + rhInvMoney(d.deliveryCharge) + '</b></div>' +
            (d.otherCharges
                ? '<div class="rhi-row"><i class="fas fa-circle-plus"></i><span>Other charges</span><b>' +
                  (d.otherCharges < 0 ? '-' : '') + rhInvMoney(Math.abs(d.otherCharges)) + '</b></div>'
                : '') +
            '<div class="rhi-row tot"><i class="fas fa-credit-card"></i><span>Total</span><b>' + rhInvMoney(d.totalPayable) + '</b></div>' +
        '</div>' +
        '<div class="rhi-id"><i class="fas fa-truck-arrow-right"></i>' +
            '<span><span class="k">CONSIGNMENT</span><span class="v">' + rhInvEsc(d.consignmentId || '\u2014') + '</span></span></div>' +
        '<div class="rhi-id"><i class="fas fa-store"></i>' +
            '<span><span class="k">SHOP ID</span><span class="v">' + rhInvEsc(d.shopId || '\u2014') + '</span></span></div>' +
        resBlock +
        '<div class="rhi-badges">' +
            '<div class="b1"><i class="fas fa-shield-halved"></i><b>CHECK BEFORE RECEIVING</b>' +
                '<span>Check the product in front of the delivery agent. Return immediately if there is any issue.</span></div>' +
            '<div class="b2"><i class="fas fa-handshake"></i><b>BANGLADESH BEST SHOP</b></div>' +
            '<div class="b3"><i class="fas fa-truck-fast"></i><b>Fast &amp; Safe Delivery</b></div>' +
        '</div>' +
        '<div class="rhi-foot">Stay with Us<span>&mdash; FOR A BETTER TOMORROW &mdash;</span></div>' +
        '<span class="rhi-wave btm"></span>' +
        '</div>';
}

var RH_INV_FORMATS = {
    a4: { w: '210mm', h: '297mm', pad: '10mm' },
    a5: { w: '148mm', h: '210mm', pad: '7mm' }
};
var RH_INV_CSS =
    '*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.rhi{font-family:Inter,Arial,Helvetica,sans-serif;color:#0f172a;font-size:10pt;line-height:1.35;position:relative;' +
        'padding:0.6em 0.8em 0;background:#fff;overflow:hidden}' +
    /* A5 is 70.5% of A4's width, so the type scales to ~72% of the A4 size —
       anything larger overflows the shorter page and spills onto a second sheet. */
    '.rhi.a5{font-size:7.2pt}' +
    '.rhi-wave{position:absolute;top:-2.4em;right:-2.4em;width:9em;height:9em;border-radius:50%;' +
        'background:linear-gradient(135deg,#dbeafe,#bfdbfe);opacity:.55}' +
    '.rhi-wave.btm{top:auto;bottom:-3em;left:-3em;right:auto;width:11em;height:11em;' +
        'background:linear-gradient(135deg,#bfdbfe,#93c5fd);opacity:.35}' +
    /* header */
    '.rhi-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1em;position:relative;z-index:1}' +
    '.rhi-hl{display:flex;align-items:center;gap:.7em}' +
    '.rhi-logo{width:2.6em;height:2.6em;border-radius:.85em;background:linear-gradient(135deg,#2b7fd4,#12558f);' +
        'color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.15em;flex:none}' +
    '.rhi-inv{font-size:2.6em;font-weight:900;letter-spacing:.02em;color:#1a5fa8;line-height:1}' +
    '.rhi-hr{text-align:right;padding-top:.15em}' +
    '.rhi-ty{font-family:"Dancing Script",cursive;font-size:1.9em;font-weight:700;color:#1a5fa8;line-height:1.05}' +
    '.rhi-ty i{font-size:.6em}' +
    '.rhi-tys{font-size:.82em;color:#64748b;margin-top:.25em}' +
    '.rhi-sub{font-size:.85em;font-weight:800;color:#475569;margin-top:.5em;position:relative;z-index:1}' +
    /* info bar */
    '.rhi-bar{display:flex;gap:0;margin-top:1.1em;background:#eef4fc;border:1px solid #d7e6f8;border-radius:.8em;' +
        'overflow:hidden;position:relative;z-index:1}' +
    '.rhi-cell{flex:1;display:flex;align-items:center;gap:.7em;padding:.85em 1em;min-width:0}' +
    '.rhi-cell+.rhi-cell{border-left:1px solid #d7e6f8}' +
    '.rhi-cell>i{font-size:1.35em;color:#1a5fa8;flex:none}' +
    '.rhi-cell>i.ok{color:#16a34a}' +
    '.rhi-cell>span{display:block;min-width:0}' +
    '.rhi-cell .k{display:block;font-size:.66em;font-weight:900;letter-spacing:.13em;color:#64748b}' +
    '.rhi-cell .v{display:block;font-size:1.15em;font-weight:900;color:#0f172a;margin-top:.12em;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.rhi-pill{display:inline-block;font-style:normal;background:#e6f8ee;color:#0f7b45;border:1px solid #b6ebcf;' +
        'border-radius:2em;padding:.05em .8em;font-size:.92em;font-weight:900}' +
    /* products */
    '.rhi-sec{display:flex;align-items:center;gap:.5em;font-size:1.05em;font-weight:900;letter-spacing:.16em;' +
        'color:#1a5fa8;margin:1.15em 0 .5em}' +
    '.rhi-sec i{font-size:1.1em}' +
    '.rhi-line{flex:1;height:1px;background:#cfe0f5;margin-left:.4em}' +
    'table.rhi-tbl{width:100%;border-collapse:collapse;border:1px solid #cfe0f5;border-radius:.6em;overflow:hidden}' +
    'table.rhi-tbl thead th{background:#1e5a96;color:#fff;font-size:.72em;font-weight:900;letter-spacing:.1em;' +
        'text-align:left;padding:.7em .8em}' +
    'table.rhi-tbl thead th.n,table.rhi-tbl thead th.c{text-align:center}' +
    'table.rhi-tbl thead th.c{width:5.4em}' +
    'table.rhi-tbl thead th.n{width:2.6em}' +
    'table.rhi-tbl tbody td{border-top:1px solid #e4eefb;padding:.65em .8em;vertical-align:middle}' +
    'table.rhi-tbl tbody td.n{text-align:center;font-weight:800;color:#334155}' +
    'table.rhi-tbl tbody td.c{text-align:center}' +
    'table.rhi-tbl tbody td.price{font-weight:900;font-size:1.12em}' +
    'table.rhi-tbl tbody td.qty{font-weight:900;font-size:1.12em}' +
    '.prow{display:flex;align-items:center;gap:.8em;min-width:0}' +
    '.pimg{width:3.4em;height:3.4em;border-radius:.5em;object-fit:cover;border:1px solid #e2e8f0;flex:none;background:#f8fafc}' +
    '.pimg.ph{display:flex;align-items:center;justify-content:center;color:#cbd5e1;font-size:1.1em}' +
    '.pmeta{display:block;min-width:0}' +
    '.pname{display:block;font-weight:800;font-size:.95em;color:#0f172a}' +
    '.psku{display:block;font-size:.78em;color:#94a3b8;margin-top:.1em}' +
    '.pvar{display:block;font-size:.78em;color:#94a3b8;margin-top:.1em}' +
    /* sums */
    '.rhi-sum{margin-top:.7em;border:1px solid #d7e6f8;border-radius:.8em;overflow:hidden;background:#eef4fc}' +
    '.rhi-row{display:flex;align-items:center;gap:.7em;padding:.7em 1em;font-size:1em;font-weight:800;color:#0f172a}' +
    '.rhi-row+.rhi-row{border-top:1px solid #d7e6f8}' +
    '.rhi-row>i{color:#1a5fa8;font-size:1.15em;flex:none}' +
    '.rhi-row>span{flex:1}' +
    '.rhi-row>b{font-size:1.15em;font-weight:900}' +
    '.rhi-row.tot>span{font-weight:900}' +
    '.rhi-row.tot>b{font-size:1.6em;font-weight:900}' +
    /* consignment / shop id */
    '.rhi-id{display:flex;align-items:center;gap:.8em;margin-top:.7em;background:#eef4fc;border:1px solid #d7e6f8;' +
        'border-radius:.8em;padding:.75em 1em}' +
    '.rhi-id>i{font-size:1.5em;color:#1a5fa8;flex:none}' +
    '.rhi-id>span{display:block;min-width:0}' +
    '.rhi-id .k{display:block;font-size:.66em;font-weight:900;letter-spacing:.16em;color:#1a5fa8}' +
    '.rhi-id .v{display:block;font-size:1.55em;font-weight:900;color:#1a5fa8;letter-spacing:.03em;margin-top:.1em;word-break:break-all}' +
    /* reseller block (admin sheets only) */
    '.rhi-res{margin-top:.7em;border:1px solid #d7e6f8;border-radius:.8em;overflow:hidden;background:#f7fbff}' +
    '.rhi-rest{background:#eef4fc;border-bottom:1px solid #d7e6f8;padding:.55em 1em;font-size:.72em;font-weight:900;' +
        'letter-spacing:.14em;color:#1a5fa8}' +
    '.rhi-rest i{margin-right:.4em}' +
    '.rhi-resg{display:flex;flex-wrap:wrap}' +
    '.rhi-resg>div{flex:1 1 50%;padding:.6em 1em;min-width:0}' +
    '.rhi-resg>div.wide{flex:1 1 100%;border-top:1px solid #e4eefb}' +
    '.rhi-resg span{display:block;font-size:.64em;font-weight:900;letter-spacing:.12em;color:#64748b}' +
    '.rhi-resg b{display:block;font-size:.92em;font-weight:800;color:#0f172a;margin-top:.15em;word-break:break-word}' +
    /* badges + footer */
    '.rhi-badges{display:flex;margin-top:1em;border-top:1px solid #e4eefb;padding-top:.9em}' +
    '.rhi-badges>div{flex:1;text-align:center;padding:0 .6em;min-width:0}' +
    '.rhi-badges>div+div{border-left:1px solid #e4eefb}' +
    '.rhi-badges i{font-size:1.5em;color:#1a5fa8;display:block;margin-bottom:.3em}' +
    '.rhi-badges b{display:block;font-size:.72em;font-weight:900;letter-spacing:.06em;color:#1e5a96}' +
    '.rhi-badges span{display:block;font-size:.66em;color:#94a3b8;margin-top:.3em;line-height:1.4}' +
    '.rhi-foot{text-align:center;margin-top:1em;font-family:"Dancing Script",cursive;font-size:1.5em;' +
        'font-weight:700;color:#1a5fa8;position:relative;z-index:1}' +
    '.rhi-foot span{display:block;font-family:Inter,Arial,sans-serif;font-size:.42em;font-weight:900;' +
        'letter-spacing:.24em;color:#64748b;margin-top:.5em}' +
    /* print */
    '@media print{ body{background:#fff} .rhi{page-break-inside:avoid} }';

/* The web fonts the design uses. Loaded per print document (the iframe does not
   inherit the page's <link>s), and the document flags readiness so the caller
   can wait instead of guessing a delay. */
var RH_INV_FONTS =
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Dancing+Script:wght@600;700&display=swap">' +
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">' +
    '<script>window.__rhFontsReady=0;(function(){function go(){window.__rhFontsReady=1}try{if(document.fonts&&document.fonts.ready){document.fonts.ready.then(go)}else{go()}}catch(e){go()}setTimeout(go,1200)})();<\/script>';

/* One document; A4/A5 flow page by page. */
function rhInvHtml(pages, format, opts) {
    opts = opts || {};
    var f = RH_INV_FORMATS[format] || RH_INV_FORMATS.a4;
    var body = '';
    for (var i = 0; i < pages.length; i++) {
        body += '<div class="rhipage' + (i < pages.length - 1 ? ' brk' : '') + '">' + pages[i] + '</div>';
    }
    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + rhInvEsc(opts.title || 'Invoice') + '</title>' +
        RH_INV_FONTS +
        '<style>' + RH_INV_CSS +
        '@page{size:' + f.w + ' ' + f.h + ';margin:0}' +
        'body{font-family:Inter,Arial,Helvetica,sans-serif;color:#0f172a;background:#fff}' +
        '.rhipage{width:' + f.w + ';min-height:' + f.h + ';padding:' + f.pad + ';display:flex;flex-direction:column}' +
        '.rhipage>.rhi{flex:1}' +
        '.brk{page-break-after:always;break-after:page}' +
        '</style></head><body>' + body + '</body></html>';
}
/* Convenience: one order -> one sheet -> one document. */
function rhInvDocFor(orders, format, opts) {
    var list = [], i;
    for (i = 0; i < (orders || []).length; i++) if (orders[i]) list.push(orders[i]);
    if (!list.length) return '';
    var pages = [];
    for (i = 0; i < list.length; i++) pages.push(rhInvSheet(rhInvData(list[i], opts), format, opts));
    return rhInvHtml(pages, format, opts);
}
/* Shared print trigger: waits for the web fonts (max 1.2s) instead of guessing
   a fixed delay, so the sheet never prints in a fallback font. */
function rhPrintFrame(html) {
    if (!html) return;
    var fr = document.createElement('iframe');
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(fr);
    var doc = fr.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    var t0 = Date.now();
    (function wait() {
        var ready = false;
        try { ready = (fr.contentWindow.__rhFontsReady === 1) || !doc.fonts; } catch (e) { ready = true; }
        if (!ready && Date.now() - t0 < 1300) { setTimeout(wait, 70); return; }
        setTimeout(function () {
            try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) { }
            setTimeout(function () { if (fr.parentNode) fr.parentNode.removeChild(fr); }, 2500);
        }, 120);
    })();
}

/* ---------- label / paper layout builder (#17 - #21) ----------
   format: 'a4' | 'a5' | 'label33' | 'label23'
   --------------------------------------------------------------------------
   NO BRAND NAMES. The sheet never carries a supplier, reseller, platform or
   marketplace name — only the parcel identifiers and the order breakdown.  */
var SHIP_FORMATS = {
    a4: { label: 'A4', w: '210mm', h: '297mm', pad: '14mm', pid: '21pt', name: '12pt', price: '11pt', tot: '15pt', thanks: '17pt' },
    a5: { label: 'A5', w: '148mm', h: '210mm', pad: '9mm', pid: '15pt', name: '9.5pt', price: '9pt', tot: '12pt', thanks: '13pt' },
    label33: { label: 'Label 3×3', w: '3in', h: '3in', pad: '2.6mm', pid: '11pt', name: '5.9pt', price: '5.9pt', tot: '7.4pt', thanks: '8pt' },
    label23: { label: 'Label 2×3', w: '2in', h: '3in', pad: '2.2mm', pid: '9.6pt', name: '5.3pt', price: '5.3pt', tot: '6.6pt', thanks: '7.2pt' }
};
function shipLabelHtml(o, supplierId, format) {
    var f = SHIP_FORMATS[format] || SHIP_FORMATS.a4;
    var small = (format === 'label33' || format === 'label23');
    /* 2026-09-18 (this request) — A4 and A5 now render the UNIFIED INVOICE sheet.
       The compact labels below are untouched, and so is every fallback: if this
       supplier has no line on the order we fall through to the old layout rather
       than printing an empty sheet. */
    if (!small) {
        var sitems = shipPrintItems(o, supplierId);
        if (sitems.length) {
            var idata = rhInvData(o, { mode: 'supplier', items: sitems, shopId: shipShopId() });
            return rhInvHtml([rhInvSheet(idata, format, {})], format, { title: 'Invoice ' + idata.orderId });
        }
    }
    var d = shipPrintData(o, supplierId);
    var esc = function (v) {
        return String(v === undefined || v === null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    var money = function (n) { return '&#2547;' + (Number(n) || 0).toLocaleString('en-IN'); };
    var pad = function (top, side, inner) { return top + ' ' + (small ? (side * 0.7).toFixed(1) : side) + 'px'; };

    var rows = '';
    for (var i = 0; i < d.items.length; i++) {
        var it = d.items[i];
        rows += '<tr>' +
            '<td class="pn">' + esc(it.name) + ' <span class="qx">&times; ' + esc(it.qty) + '</span>' +
            (it.variant ? '<span class="vr">' + esc(it.variant) + '</span>' : '') + '</td>' +
            '<td class="pc">' + money(it.retail) + '</td>' +
            '<td class="pc rs">' + money(it.resale) + '</td>' +
            '</tr>';
    }
    if (!rows) rows = '<tr><td class="pn">Order items</td><td class="pc">—</td><td class="pc">—</td></tr>';

    /* ---- identifiers: PARCEL ID + CONSIGNMENT ID at the very top, SHOP ID below ---- */
    var ids =
        '<div class="ids">' +
        '<div class="idrow">' +
        '<div class="idb"><small>PARCEL ID</small><span class="pid">' + esc(d.parcelId || '—') + '</span></div>' +
        '<div class="idb"><small>CONSIGNMENT ID</small><span class="pid">' + esc(d.consignmentId || d.parcelId || '—') + '</span></div>' +
        '</div>' +
        '<div class="shoprow"><small>SHOP ID</small><span class="shop">' + esc(d.shopId) + '</span></div>' +
        '</div>';

    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Label ' + esc(d.parcelId) + '</title><style>' +
        '*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
        '@page{size:' + f.w + ' ' + f.h + ';margin:0}' +
        'html,body{width:' + f.w + ';min-height:' + f.h + '}' +
        'body{font-family:Inter,Arial,Helvetica,sans-serif;color:#0f172a;padding:' + f.pad + ';display:flex;flex-direction:column}' +
        '.sheet{flex:1;display:flex;flex-direction:column;border:1px solid #cbd5e1;border-radius:6px;overflow:hidden;page-break-inside:avoid}' +
        /* top identity block */
        '.ids{background:#0f172a;color:#fff;padding:' + pad(10, 14, 0) + '}' +
        '.idrow{display:flex;gap:10px}' +
        '.idb{flex:1;min-width:0;text-align:center;background:rgba(255,255,255,.09);border-radius:5px;padding:' + (small ? '4px 5px' : '8px 10px') + '}' +
        '.idb small{display:block;font-size:' + (small ? '4.9pt' : '7.4pt') + ';letter-spacing:1.5px;font-weight:800;opacity:.75;margin-bottom:2px}' +
        '.pid{display:block;font-size:' + f.pid + ';font-weight:900;letter-spacing:1px;font-family:"Courier New",monospace;line-height:1.15;word-break:break-all}' +
        '.shoprow{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:' + (small ? '5px' : '9px') + '}' +
        '.shoprow small{font-size:' + (small ? '4.9pt' : '7.4pt') + ';letter-spacing:1.5px;font-weight:800;opacity:.75}' +
        '.shop{font-size:' + (small ? '7pt' : '10pt') + ';font-weight:900;letter-spacing:1.5px;font-family:"Courier New",monospace}' +
        /* item table */
        '.body{flex:1;padding:' + pad(8, 14, 0) + ';overflow:hidden}' +
        'table.pt{width:100%;border-collapse:collapse}' +
        'table.pt th{font-size:' + (small ? '4.9pt' : '7.6pt') + ';font-weight:900;letter-spacing:.7px;color:#64748b;text-align:left;padding:' + (small ? '3px 2px' : '6px 3px') + ';border-bottom:1.5px solid #cbd5e1}' +
        'table.pt th:not(:first-child){text-align:right}' +
        'table.pt td{padding:' + (small ? '3px 2px' : '7px 3px') + ';border-bottom:1px dashed #e2e8f0;vertical-align:top}' +
        '.pn{font-size:' + f.name + ';font-weight:700;line-height:1.35;word-break:break-word}' +
        '.qx{color:#64748b;font-weight:800;white-space:nowrap;font-size:' + (small ? '4.9pt' : '8.4pt') + '}' +
        '.vr{display:block;font-size:' + (small ? '4.7pt' : '7.6pt') + ';color:#94a3b8;font-weight:600;margin-top:1px}' +
        '.pc{font-size:' + f.price + ';font-weight:900;white-space:nowrap;text-align:right}' +
        '.pc.rs{color:#0f172a}' +
        /* bottom identity + sums */
        '.foot{border-top:2px solid #0f172a}' +
        '.srow{display:flex;justify-content:space-between;gap:8px;padding:' + (small ? '3px 7px' : '7px 14px') + ';font-size:' + (small ? '5.9pt' : '10pt') + ';font-weight:700;border-bottom:1px solid #e2e8f0}' +
        '.srow.total{background:#0f172a;color:#fff;border-bottom:none;font-size:' + f.tot + ';font-weight:900;padding:' + (small ? '5px 7px' : '11px 14px') + '}' +
        '.thanks{text-align:center;font-size:' + f.thanks + ';font-weight:900;letter-spacing:.5px;padding:' + (small ? '6px' : '18px') + '}' +
        '@media print{ body{padding:' + f.pad + '} }' +
        '</style></head><body>' +
        '<div class="sheet">' + ids +
        '<div class="body">' +
        '<table class="pt"><thead><tr><th>Product</th><th>Retail Price</th><th>Price</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '</div>' +
        '<div class="foot">' +
        '<div class="srow"><span>Delivery Charge</span><span>' + money(d.deliveryCharge) + '</span></div>' +
        '<div class="srow total"><span>Total Payable</span><span>' + money(d.totalPayable) + '</span></div>' +
        '<div class="thanks">' + esc(d.thankYou) + '</div>' +
        '</div>' +
        '</div></body></html>';
}

/* ---------- BULK: many supplier orders in ONE print job ----------
   Each order gets its own page (a label = one page). The per-page document is
   reused verbatim so bulk output is byte-identical to printing one at a time. */
function shipBulkLabelHtml(orders, supplierId, format) {
    if (!orders || !orders.length) return '';
    var f = SHIP_FORMATS[format] || SHIP_FORMATS.a4;
    var esc = function (v) {
        return String(v === undefined || v === null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    var pages = '';
    for (var i = 0; i < orders.length; i++) {
        var one = shipLabelHtml(orders[i], supplierId, format);
        var inner = one.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '');
        var css = (one.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
        if (i === 0) {
            pages += '<style id="shipBulkCss">' + css + '</style>';
        }
        pages += '<div class="bulkpage' + (i < orders.length - 1 ? ' brk' : '') + '">' + inner + '</div>';
    }
    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + esc(orders.length) + ' Label(s)</title>' +
        /* the A4/A5 pages inside this document are unified invoice sheets, so the
           fonts they need must be loaded here as well */
        RH_INV_FONTS +
        '<style>' +
        '*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
        '@page{size:' + f.w + ' ' + f.h + ';margin:0}' +
        'body{background:#fff}' +
        '.bulkpage{width:' + f.w + ';height:' + f.h + ';padding:' + f.pad + ';display:flex;flex-direction:column}' +
        '.bulkpage .sheet{flex:1}' +
        '.brk{page-break-after:always;break-after:page}' +
        '@media print{ body{background:#fff} }' +
        '</style></head><body>' + pages + '</body></html>';
}

/* ==========================================================================
   ADMIN ORDER PRINT SYSTEM
   --------------------------------------------------------------------------
   READ-ONLY. Printing never creates a Steadfast shipment, never changes an
   order status and never generates an ID — it only reads what is already
   stored on the order.
   Formats: A4 | A5 | Label 3x2 | Label 3x3
   ========================================================================== */

/* Shop ID — dynamic when configured in settings, otherwise the fixed default. */
function shipShopId() {
    try {
        var s = getOne(DB_KEYS.SETTINGS);
        var v = String(s.ship_shop_id || '').trim();
        if (v) return v;
    } catch (e) {}
    return SHIP_SHOP_ID;
}

/* (#3, #4, #20, #23) Resolve the REAL shipment identifier already on the order.
   Never invents one; returns '' when the order has not been booked yet. */
function adminOrderParcelId(o) {
    if (!o) return '';
    var v = o.steadfast_parcel_id || o.steadfast_consignment_id || o.consignment_id ||
            o.parcel_id || o.consignmentId || o.trackingId || '';
    if (v) return String(v);
    /* legacy supplier courier entries */
    if (o.courierEntries && o.courierEntries.length) {
        for (var i = 0; i < o.courierEntries.length; i++) {
            var c = o.courierEntries[i];
            if (c && c.consignment) return String(c.consignment);
        }
    }
    return '';
}
function adminOrderIsBooked(o) { return !!adminOrderParcelId(o); }

/* (#2, #19) Reseller information straight from the reseller record. */
function adminOrderResellerInfo(o) {
    var rid = o ? o.resellerId : null;
    var list = getData(DB_KEYS.RESELLERS) || [], r = null;
    for (var i = 0; i < list.length; i++) { if (String(list[i].id) === String(rid)) { r = list[i]; break; } }
    if (!r) {
        return {
            name: (o && (o.resellerName || o.reseller_name)) || 'Reseller',
            phone: (o && o.resellerPhone) || '',
            address: (o && o.resellerAddress) || '',
            found: false
        };
    }
    return {
        name: r.businessName || r.business || r.shop_name || r.shopName || r.name || 'Reseller',
        phone: r.phone || r.shop_phone || '',
        address: r.shop_address || r.address || r.businessAddress || '',
        found: true
    };
}

/* (#5 - #8) Products, shipping charge and the authoritative total. */
function adminOrderPrintItems(o) {
    var out = [];
    if (!o) return out;
    if (o.items && o.items.length) {
        for (var i = 0; i < o.items.length; i++) {
            var it = o.items[i] || {};
            var retail = Number(it.resale || it.customer_price || it.price || 0);
            var qty = Number(it.qty) || 1;
            out.push({
                name: String(it.name || o.productName || 'Product'),
                qty: qty,
                retail: retail,
                line: retail * qty,
                /* 2026-09-18 — picture + code for the unified invoice sheet */
                productId: (it.productId === undefined || it.productId === null) ? '' : it.productId,
                image: rhInvLineImage(it),
                sku: rhInvLineSku(it),
                variant: [it.size, it.color, it.variant].filter(function (x) { return !!x; }).join(' / ')
            });
        }
        return out;
    }
    var r2 = Number(o.resale || o.productPrice || o.amount || 0);
    var q2 = Number(o.qty) || 1;
    out.push({
        name: String(o.productName || 'Product'), qty: q2,
        retail: r2, line: r2 * q2,
        productId: (o.productId === undefined || o.productId === null) ? '' : o.productId,
        image: rhInvLineImage({ productId: o.productId, image: o.image }),
        sku: rhInvLineSku({ productId: o.productId, sku: o.sku }),
        variant: [o.size, o.color].filter(function (x) { return !!x; }).join(' / ')
    });
    return out;
}
function adminOrderPrintData(o) {
    var items = adminOrderPrintItems(o);
    var productTotal = 0, qty = 0;
    for (var i = 0; i < items.length; i++) { productTotal += items[i].line; qty += items[i].qty; }
    var shipping = Number(o && o.shippingCharge) || 0;
    /* (#8) the stored order amount is the source of truth; only fall back to a
       computed value when it is missing so we never contradict the order. */
    var stored = Number(o && o.amount);
    var totalPayable = (o && o.amount !== undefined && o.amount !== null && !isNaN(stored) && stored > 0)
        ? stored
        : (productTotal + shipping);
    var parcel = adminOrderParcelId(o);
    return {
        orderId: o ? String(o.id) : '',
        date: (o && o.date) ? String(o.date).slice(0, 10) : '',
        reseller: adminOrderResellerInfo(o),
        parcelId: parcel,
        parcelAvailable: !!parcel,
        shopId: shipShopId(),
        items: items,
        productTotal: productTotal,
        totalQty: qty,
        shippingCharge: shipping,
        shippingMethod: orderShippingLabel(o),
        totalPayable: totalPayable,
        thankYou: 'Thank You For Your Order!',
        thankYouSub: 'We truly appreciate your purchase.'
    };
}

/* (#12, #13, #17) Four physical formats. */
var ADMIN_PRINT_FORMATS = {
    a4: { key: 'a4', label: 'A4', w: '210mm', h: '297mm', pad: '14mm' },
    a5: { key: 'a5', label: 'A5', w: '148mm', h: '210mm', pad: '9mm' },
    label32: { key: 'label32', label: '3 × 2 Label', w: '3in', h: '2in', pad: '2.4mm' },
    label33: { key: 'label33', label: '3 × 3 Label', w: '3in', h: '3in', pad: '3mm' }
};

/* (#15, #16) Build one order's print sheet. */
function adminOrderPrintSheet(o, format) {
    var f = ADMIN_PRINT_FORMATS[format] || ADMIN_PRINT_FORMATS.a4;
    var label = (format === 'label32' || format === 'label33');
    /* 2026-09-18 (this request) — A4/A5 render the UNIFIED INVOICE sheet, and
       being the ADMIN sheet it also carries the four reseller details.
       The 3x2 / 3x3 labels below are untouched. */
    if (!label) {
        return rhInvSheet(
            rhInvData(o, { mode: 'admin', items: adminOrderPrintItems(o), shopId: shipShopId() }),
            format, {});
    }
    var d = adminOrderPrintData(o);
    var esc = function (v) {
        return String(v === undefined || v === null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    var money = function (n) { return '&#2547;' + (Number(n) || 0).toLocaleString('en-IN'); };

    var rows = '';
    for (var i = 0; i < d.items.length; i++) {
        var it = d.items[i];
        rows += '<tr><td class="pn">' + esc(it.name) + ' <span class="qx">&times; ' + esc(it.qty) + '</span>' +
            (it.variant ? '<span class="vr">' + esc(it.variant) + '</span>' : '') +
            '</td><td class="pp">' + money(it.line) + '</td></tr>';
    }
    if (!rows) rows = '<tr><td class="pn">Order items</td><td class="pp">—</td></tr>';

    var parcelBlock = d.parcelAvailable
        ? '<div class="pid"><small>PARCEL ID</small>' + esc(d.parcelId) + '</div><div class="shop">Shop ID: ' + esc(d.shopId) + '</div>'
        : '<div class="pid na"><small>PARCEL ID</small>Not Available</div><div class="shop">Shop ID: ' + esc(d.shopId) + '</div>';

    /* ---- label layouts: compact, priority order ---- */
    if (label) {
        return '<div class="sheet' + (format === 'label32' ? ' l32' : ' l33') + '">' +
            '<div class="lb-top">' +
            '<div class="lb-res">' + esc(d.reseller.name) + '</div>' +
            '<div class="lb-sub">' + esc(d.reseller.phone) + (d.reseller.address ? ' • ' + esc(d.reseller.address) : '') + '</div>' +
            '</div>' +
            '<div class="lb-body"><table class="pt">' + rows + '</table>' +
            '<div class="lb-sum"><span>Ship: ' + money(d.shippingCharge) + '</span><b>TOTAL: ' + money(d.totalPayable) + '</b></div>' +
            '</div>' +
            '<div class="lb-ids">' + parcelBlock + '</div>' +
            '<div class="lb-thx">' + esc(d.thankYou) + '</div>' +
            '</div>';
    }

    /* ---- A4 / A5 ---- */
    return '<div class="sheet' + (format === 'a5' ? ' a5' : '') + '">' +
        '<div class="hd">' +
        '<div class="hd-l">' +
        '<div class="rname">' + esc(d.reseller.name) + '</div>' +
        '<div class="rline">' + (d.reseller.phone ? '<i class="ic">☎</i> ' + esc(d.reseller.phone) : '') + '</div>' +
        '<div class="rline">' + (d.reseller.address ? esc(d.reseller.address) : '') + '</div>' +
        '</div>' +
        '<div class="hd-r">' + parcelBlock + '</div>' +
        '</div>' +
        '<div class="sect">ORDER DETAILS</div>' +
        '<table class="pt"><thead><tr><th>Product</th><th class="pp">Retail Price</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="sums">' +
        '<div class="srow"><span>Shipping Charge' + (d.shippingMethod ? ' <small>(' + esc(d.shippingMethod) + ')</small>' : '') + '</span><b>' + money(d.shippingCharge) + '</b></div>' +
        '<div class="srow total"><span>TOTAL PAYABLE</span><b>' + money(d.totalPayable) + '</b></div>' +
        '</div>' +
        '<div class="thx"><b>' + esc(d.thankYou) + '</b><span>' + esc(d.thankYouSub) + '</span></div>' +
        '<div class="meta"><span>Order: ' + esc(d.orderId) + '</span><span>' + esc(d.date) + '</span></div>' +
        '</div>';
}

/* (#22) One document; A4/A5 flow page by page, labels get one page each. */
function adminOrderPrintHtml(orders, format) {
    if (!orders || !orders.length) return '';
    var f = ADMIN_PRINT_FORMATS[format] || ADMIN_PRINT_FORMATS.a4;
    var isLabel = (format === 'label32' || format === 'label33');
    var labelFont = format === 'label32' ? 'l32' : 'l33';

    var body = '';
    for (var i = 0; i < orders.length; i++) {
        body += '<div class="page' + (i < orders.length - 1 ? ' brk' : '') + '">' + adminOrderPrintSheet(orders[i], format) + '</div>';
    }

    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Order Print</title>' +
        /* 2026-09-18 (this request) — the unified invoice sheet is produced by
           rhInvSheet(), so its stylesheet and its web fonts must travel with THIS
           document too. RH_INV_CSS is concatenated into the single <style> block
           on purpose: adminPrintCssFor() lifts the first <style> to style the
           multi-supplier invoice, and a second block would silently drop these
           rules from that path. */
        RH_INV_FONTS +
        '<style>' + RH_INV_CSS +
        '*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
        '@page{size:' + f.w + ' ' + f.h + ';margin:0}' +
        'body{font-family:Inter,Arial,Helvetica,sans-serif;color:#0f172a;background:#fff}' +
        '.page{width:' + f.w + ';min-height:' + f.h + ';padding:' + f.pad + '}' +
        '.brk{page-break-after:always;break-after:page}' +
        '.sheet{height:100%;display:flex;flex-direction:column}' +
        /* header */
        '.hd{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;border-bottom:2.5px solid #0f172a;padding-bottom:12px;margin-bottom:14px}' +
        '.hd-l{flex:1;min-width:0}' +
        '.rname{font-size:19px;font-weight:900;line-height:1.2;word-break:break-word}' +
        '.rline{font-size:11px;color:#475569;margin-top:3px;line-height:1.45}' +
        '.hd-r{flex:none;text-align:right;background:#f1f5f9;border-radius:8px;padding:10px 14px;min-width:190px}' +
        '.pid{font-size:20px;font-weight:900;font-family:"Courier New",monospace;letter-spacing:1px;line-height:1.15;word-break:break-all}' +
        '.pid.na{font-size:14px;color:#b45309}' +
        '.pid small{display:block;font-size:8px;letter-spacing:1.6px;color:#64748b;font-weight:800;margin-bottom:2px}' +
        '.shop{font-size:12px;font-weight:900;font-family:"Courier New",monospace;letter-spacing:1.2px;margin-top:6px}' +
        /* sections */
        '.sect{font-size:10px;font-weight:900;letter-spacing:1.4px;color:#64748b;margin-bottom:6px}' +
        'table.pt{width:100%;border-collapse:collapse}' +
        'table.pt th{font-size:9px;font-weight:900;letter-spacing:.8px;color:#64748b;text-transform:uppercase;text-align:left;padding:6px 4px;border-bottom:1.5px solid #cbd5e1}' +
        'table.pt td{font-size:12px;padding:8px 4px;border-bottom:1px dashed #e2e8f0;vertical-align:top}' +
        '.pn{font-weight:700;word-break:break-word}' +
        '.qx{color:#64748b;font-weight:800;white-space:nowrap}' +
        '.vr{display:block;font-size:9.5px;color:#94a3b8;font-weight:600;margin-top:2px}' +
        '.pp{text-align:right;font-weight:900;white-space:nowrap}' +
        /* sums */
        '.sums{margin-top:auto;padding-top:14px}' +
        '.srow{display:flex;justify-content:space-between;font-size:12px;padding:6px 0;border-bottom:1px solid #e2e8f0}' +
        '.srow small{color:#94a3b8;font-weight:600}' +
        '.srow.total{border-bottom:none;border-top:2.5px solid #0f172a;margin-top:6px;padding-top:10px;font-size:17px;font-weight:900}' +
        '.thx{margin-top:18px;border-top:2px solid #0f172a;padding-top:12px;text-align:center}' +
        '.thx b{display:block;font-size:15px;font-weight:900}' +
        '.thx span{display:block;font-size:10px;color:#64748b;margin-top:3px}' +
        '.meta{display:flex;justify-content:space-between;font-size:9px;color:#94a3b8;margin-top:10px}' +
        /* A5 tweaks */
        '.sheet.a5 .rname{font-size:15px}.sheet.a5 .pid{font-size:15px}.sheet.a5 .hd-r{min-width:150px;padding:8px 10px}' +
        '.sheet.a5 table.pt td{font-size:10px;padding:6px 3px}.sheet.a5 .srow.total{font-size:14px}.sheet.a5 .thx b{font-size:12px}' +
        /* label layout */
        '.sheet.l32,.sheet.l33{border:1px solid #cbd5e1;border-radius:5px;overflow:hidden;page-break-inside:avoid}' +
        '.lb-top{background:#0f172a;color:#fff;padding:5px 8px}' +
        '.lb-res{font-size:11px;font-weight:900;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '.lb-sub{font-size:7.5px;opacity:.85;margin-top:2px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '.lb-body{flex:1;padding:5px 8px;overflow:hidden}' +
        '.lb-body table.pt th{display:none}' +
        '.lb-body table.pt td{font-size:9px;padding:3px 0;border-bottom:1px dashed #e2e8f0}' +
        '.lb-body table.pt .vr{font-size:7.5px}' +
        '.lb-sum{display:flex;justify-content:space-between;gap:6px;font-size:8.5px;font-weight:800;margin-top:4px;padding-top:4px;border-top:1.5px solid #0f172a}' +
        '.lb-ids{background:#f1f5f9;border-top:1.5px solid #0f172a;padding:5px 8px;text-align:center}' +
        '.lb-ids .pid{font-size:13px}.lb-ids .pid.na{font-size:10px}.lb-ids .shop{font-size:9px;margin-top:3px}' +
        '.lb-thx{text-align:center;font-size:8px;font-weight:900;padding:4px 6px;background:#0f172a;color:#fff;letter-spacing:.3px}' +
        '.sheet.l32 .lb-res{font-size:10px}.sheet.l32 .lb-body table.pt td{font-size:8px;padding:2px 0}' +
        '.sheet.l32 .lb-ids .pid{font-size:12px}.sheet.l32 .lb-thx{font-size:7.4px}' +
        '@media print{ body{background:#fff} }' +
        '</style></head><body>' + body + '</body></html>';
}

/* ==========================================================================
   OFFERS + BANNERS
   --------------------------------------------------------------------------
   Model:
     OFFER DEFINITION  -> DB_KEYS.OFFERS   (one row per offer, shared by all)
     RESELLER STATE    -> DB_KEYS.OFFER_STATE (offerId|resellerId -> state)
   One reseller's progress/claim NEVER touches another reseller's state.

   "Completed order" reuses the existing definition: order.status === 'delivered'
   (the same status that credits reseller profit elsewhere in the app).

   NOTE ON SECURITY: this is a 100% client-side app. Claim idempotency and the
   global claim limit are enforced in this data layer, which is the strongest
   persistence available here — but a determined user with devtools can still
   edit localStorage. Server-side enforcement is required before real money is
   paid out. See the implementation report.
   ========================================================================== */

var OFFER_COMPLETED_STATUS = 'delivered';   /* existing definition of a completed order */

/* ---------- banners (extends the existing rh_banners store) ---------- */
/* Recommended banner geometry — keeps the dashboard grid consistent. */
var BANNER_RECOMMENDED = { w: 1200, h: 300, ratio: '4:1', maxKB: 600 };

function getBanners() {
    var b = getData(DB_KEYS.BANNERS);
    return Object.prototype.toString.call(b) === '[object Array]' ? b : [];
}
function saveBanners(list) { setData(DB_KEYS.BANNERS, list); return list; }
function getBannerById(id) {
    var list = getBanners();
    for (var i = 0; i < list.length; i++) { if (String(list[i].id) === String(id)) return list[i]; }
    return null;
}
function activeBanners() {
    var list = getBanners(), out = [];
    for (var i = 0; i < list.length; i++) { if (list[i] && list[i].active !== false) out.push(list[i]); }
    return out;
}
/* Only http(s) and app-relative links are allowed — blocks javascript:/data: etc. */
function safeUrl(u) {
    var v = String(u === undefined || u === null ? '' : u).trim();
    if (!v) return '';
    if (/^(https?:)?\/\//i.test(v)) return v;
    if (/^[a-z0-9_\-.\/?#=&%+:]+$/i.test(v) && v.indexOf('//') !== 0) return v;
    return '';
}
function bannerLinkTarget(b) {
    if (!b) return '';
    return safeUrl(b.link);
}

/* ---------- offers ---------- */
function getOffers() {
    var o = getData(DB_KEYS.OFFERS);
    return Object.prototype.toString.call(o) === '[object Array]' ? o : [];
}
function saveOffers(list) { setData(DB_KEYS.OFFERS, list); return list; }
function getOfferById(id) {
    var list = getOffers();
    for (var i = 0; i < list.length; i++) { if (String(list[i].id) === String(id)) return list[i]; }
    return null;
}

/* ---------- per-reseller state ---------- */
function getOfferStates() {
    var s = getData(DB_KEYS.OFFER_STATE);
    if (Object.prototype.toString.call(s) === '[object Array]') return {};
    return (s && typeof s === 'object') ? s : {};
}
function saveOfferStates(obj) { setData(DB_KEYS.OFFER_STATE, obj); return obj; }
function offerStateKey(offerId, resellerId) { return String(offerId) + '|' + String(resellerId); }
function getOfferState(offerId, resellerId) {
    var all = getOfferStates();
    return all[offerStateKey(offerId, resellerId)] || null;
}
function patchOfferState(offerId, resellerId, patch) {
    var all = getOfferStates();
    var k = offerStateKey(offerId, resellerId);
    var st = all[k] || { offerId: offerId, resellerId: resellerId, startedAt: null, claimed: false, claimedAt: null, rewardRef: null };
    for (var p in patch) { if (Object.prototype.hasOwnProperty.call(patch, p)) st[p] = patch[p]; }
    all[k] = st;
    saveOfferStates(all);
    return st;
}
/* every state row of one offer (used by admin counters) */
function offerStatesOfOffer(offerId) {
    var all = getOfferStates(), out = [];
    for (var k in all) {
        if (!Object.prototype.hasOwnProperty.call(all, k)) continue;
        if (String(all[k].offerId) === String(offerId)) out.push(all[k]);
    }
    return out;
}

/* ---------- offer helpers ---------- */
function offerStartMs(o) {
    if (!o || !o.createdAt) return 0;
    var t = new Date(o.createdAt).getTime();
    return isNaN(t) ? 0 : t;
}
function offerValidUntilMs(o) {
    if (!o) return 0;
    if (o.validUntil) { var t = new Date(o.validUntil).getTime(); if (!isNaN(t)) return t; }
    var days = Number(o.validDays) || 0;
    if (!days) return 0;                    /* 0 = no global expiry */
    return offerStartMs(o) + days * 86400000;
}
function offerIsExpired(o, nowMs) {
    var until = offerValidUntilMs(o);
    if (!until) return false;
    return (nowMs || Date.now()) > until;
}
function offerClaimsUsed(o) {
    if (!o) return 0;
    /* derived from real state rows — never trust a stored counter alone */
    var rows = offerStatesOfOffer(o.id), n = 0;
    for (var i = 0; i < rows.length; i++) { if (rows[i] && rows[i].claimed) n++; }
    var stored = Number(o.claimsUsed) || 0;
    return Math.max(n, stored);
}
function offerLimitReached(o) {
    var limit = Number(o && o.claimLimit) || 0;
    if (limit <= 0) return false;           /* 0 = unlimited */
    return offerClaimsUsed(o) >= limit;
}
function offerExcluded(o, resellerId) {
    if (!o || !o.excludedResellers) return false;
    var list = o.excludedResellers;
    for (var i = 0; i < list.length; i++) { if (String(list[i]) === String(resellerId)) return true; }
    return false;
}
function offerBannerIds(o) {
    if (!o || !o.bannerIds) return [];
    return Object.prototype.toString.call(o.bannerIds) === '[object Array]' ? o.bannerIds : [];
}
function offerBanners(o) {
    var ids = offerBannerIds(o), out = [];
    for (var i = 0; i < ids.length; i++) {
        var b = getBannerById(ids[i]);
        if (b && b.active !== false) out.push(b);
    }
    return out;
}
function offerRewardLabel(o) {
    if (!o) return '';
    if (o.rewardMethod === 'link') return 'Reward Link';
    /* 2026-09-19 — the third reward type: free trial days */
    if (o.rewardMethod === 'free_trial') {
        var d = Number(o.rewardTrialDays) || 0;
        return d ? (d + ' দিনের ফ্রি ট্রায়াল') : 'ফ্রি ট্রায়াল';
    }
    return '৳' + (Number(o.rewardAmount) || 0).toLocaleString('en-IN') + ' Cash';
}

/* ---------- progress (rolling window, spec #6) ----------
   Counts the reseller's DELIVERED orders that fall inside their own window
   [startedAt, startedAt + windowDays]. Orders outside the window never count.

   (#7, #8, #9) An order only advances the target if it carries at least one
   ADMIN or SUPPLIER product line. An order made purely of the reseller's own
   uploaded products can never satisfy an offer criterion. */
function resellerDeliveredOrdersBetween(resellerId, fromMs, toMs) {
    var orders = getData(DB_KEYS.ORDERS) || [], n = 0;
    var lo = Number(fromMs), hi = Number(toMs);
    /* (#8) Each ORDER counts once. Orders are identified by id, so a record that
       somehow appears twice in the store can never double-count the progress. */
    var seen = {};
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o) continue;
        var oid = (o.id !== undefined && o.id !== null && o.id !== '') ? String(o.id) : ('__idx' + i);
        if (seen[oid]) continue;
        if (String(o.resellerId) !== String(resellerId)) continue;
        if (String(o.status) !== OFFER_COMPLETED_STATUS) continue;
        if (!orderCountsForOffer(o)) continue;      /* own-product-only order -> not eligible */
        var t = orderTimeMs(o);
        if (!t) continue;
        /* Number() first — comparing against a NaN bound would silently drop
           every order and freeze the offer at 0 forever. */
        if (!isNaN(lo) && lo && t < lo) continue;
        if (!isNaN(hi) && hi && t > hi) continue;
        seen[oid] = true;
        n++;
    }
    return n;
}
function offerDeadlineMs(o, state) {
    if (!state || !state.startedAt) return 0;
    var days = Number(o && o.windowDays) || 0;
    if (!days) return 0;
    var s = new Date(state.startedAt).getTime();
    if (isNaN(s)) return 0;
    return s + days * 86400000;
}
function offerProgress(o, resellerId) {
    var target = Number(o && o.target) || 0;
    var st = getOfferState(o.id, resellerId);
    var count = 0, deadline = 0;
    if (st && st.startedAt) {
        /* 2026-09-20 — BUG FIX v3 (revert the v2 mistake).
           v2 dropped the lower bound entirely ("all eligible delivered orders
           count"). That meant a reseller with 5 delivered orders from a year
           ago could create a brand-new offer today with target=1 and immediately
           Claim — a clean exploit of the bonus program.
           v3: lower bound = when the offer became available (createdAt). Orders
           delivered BEFORE the offer existed do not count (the reseller could
           not have known about the bonus). Orders delivered between createdAt
           and the deadline DO count — that's the original spec, and it's also
           what fixes the original bug ("orders delivered before pressing Start
           but after the offer was published").
           For legacy offers with no createdAt, fall back to startedAt — the
           original behaviour, kept so the existing offers don't change. */
        var pub = offerStartMs(o);
        var started = new Date(st.startedAt).getTime();
        var from = pub > 0 ? pub : (isNaN(started) ? 0 : started);
        deadline = offerDeadlineMs(o, st);
        var now = Date.now();
        var to = deadline ? Math.min(deadline, now) : now;
        if (!isNaN(from)) count = resellerDeliveredOrdersBetween(resellerId, from, to);
    }
    var pct = target > 0 ? Math.min(100, Math.round(count * 100 / target)) : 0;
    return {
        count: count, target: target, pct: pct,
        started: !!(st && st.startedAt),
        deadlineMs: deadline,
        complete: target > 0 && count >= target
    };
}

/* ---------- status for one reseller (spec #7, #24) ---------- */
function offerStatusFor(o, resellerId) {
    if (!o) return 'not_eligible';
    var now = Date.now();
    if (o.active === false) return 'closed';
    if (offerExcluded(o, resellerId)) return 'not_eligible';
    var st = getOfferState(o.id, resellerId);
    if (st && st.claimed) return 'claimed';
    if (offerIsExpired(o, now)) return (o.expiryBehavior === 'message') ? 'expired' : 'expired';
    if (offerLimitReached(o)) return 'limit_reached';
    if (!st || !st.startedAt) return 'available';
    var pr = offerProgress(o, resellerId);
    if (pr.deadlineMs && now > pr.deadlineMs && !pr.complete) return 'expired';
    if (pr.complete) return 'ready';
    return 'in_progress';
}
function offerStatusLabel(s) {
    var map = {
        available: 'Available', in_progress: 'In Progress', ready: 'Completed — Ready to Claim',
        claimed: 'Claimed', expired: 'Expired', closed: 'Closed',
        limit_reached: 'Limit Reached', not_eligible: 'Not Eligible'
    };
    return map[s] || 'Active';
}
/* Should this offer appear on the reseller's Offers page at all? */
function offerVisibleTo(o, resellerId) {
    if (!o) return false;
    if (offerExcluded(o, resellerId)) return false;          /* spec #9 */
    var st = getOfferState(o.id, resellerId);
    if (st && st.claimed) return true;                        /* keep history visible */
    if (o.active === false) {
        return (o.expiryBehavior === 'message') && offerIsExpired(o, Date.now());
    }
    if (offerIsExpired(o, Date.now())) {
        return (o.expiryBehavior === 'message');              /* OPTION A hides, B keeps */
    }
    return true;
}

/* ---------- start ---------- */
function startOffer(offerId, resellerId) {
    var o = getOfferById(offerId);
    if (!o) return { ok: false, message: 'Offer পাওয়া যায়নি।' };
    if (o.active === false) return { ok: false, message: 'এই offer বন্ধ।' };
    if (offerExcluded(o, resellerId)) return { ok: false, message: 'আপনি এই offer-এর জন্য eligible নন।' };
    if (offerIsExpired(o, Date.now())) return { ok: false, message: 'Offer-এর সময় শেষ হয়ে গেছে।' };
    var st = getOfferState(offerId, resellerId);
    if (st && st.startedAt) return { ok: true, already: true };
    patchOfferState(offerId, resellerId, { startedAt: new Date().toISOString() });
    return { ok: true };
}

/* ---------- claim (spec #8, #10, #11) ---------- */
var offerClaimLock = {};   /* in-memory guard against double-clicks / double-taps */

function claimOffer(offerId, resellerId) {
    var key = offerStateKey(offerId, resellerId);
    if (offerClaimLock[key]) return { ok: false, message: 'Processing…' };
    offerClaimLock[key] = true;
    try {
        var o = getOfferById(offerId);
        if (!o) return { ok: false, message: 'Offer পাওয়া যায়নি।' };
        /* re-validate everything at claim time — never trust the UI */
        if (o.active === false) return { ok: false, message: 'এই offer বন্ধ করে দেওয়া হয়েছে।' };
        if (offerExcluded(o, resellerId)) return { ok: false, message: 'আপনি এই offer-এর জন্য eligible নন।' };
        if (offerIsExpired(o, Date.now())) return { ok: false, message: 'Offer-এর সময় শেষ হয়ে গেছে।' };
        if (offerLimitReached(o)) return { ok: false, message: 'Global claim limit পূর্ণ হয়ে গেছে।' };

        var st = getOfferState(offerId, resellerId);
        if (!st || !st.startedAt) return { ok: false, message: 'আগে offer-টি Start করুন।' };
        if (st.claimed) return { ok: false, already: true, message: 'আপনি ইতিমধ্যে এই reward claim করেছেন।' };

        var pr = offerProgress(o, resellerId);
        if (!pr.complete) return { ok: false, message: 'Target এখনো পূরণ হয়নি (' + pr.count + '/' + pr.target + ')।' };
        if (pr.deadlineMs && Date.now() > pr.deadlineMs) return { ok: false, message: 'Completion window শেষ হয়ে গেছে।' };

        /* ---- reward ---- */
        var ref = 'OFFER-' + o.id + '-R' + resellerId + '-' + Date.now();
        var note = 'Offer Reward — ' + (o.title || ('Offer #' + o.id));
        var isLink  = (o.rewardMethod === 'link');
        var isTrial = (o.rewardMethod === 'free_trial');
        var isCash  = !isLink && !isTrial;

        if (isTrial) {
            /* 2026-09-19 — the THIRD reward type: N days of free trial. It stacks
               onto whatever the reseller already has and starts after any paid
               premium, so a reward can never take days away from anybody. */
            var _d = Math.max(1, parseInt(o.rewardTrialDays, 10) || 0);
            var _g = premiumGrantTrialDays(resellerId, _d);
            if (!_g || !_g.ok) {
                offerClaimLock[key] = false;
                return { ok: false, message: 'ফ্রি ট্রায়াল যোগ করা যায়নি — আবার চেষ্টা করুন।' };
            }
        } else if (isCash) {
            var amount = Number(o.rewardAmount) || 0;
            if (amount <= 0) return { ok: false, message: 'Reward amount সঠিক নয়।' };
            /* existing wallet + ledger — no second wallet system */
            var resellers = getData(DB_KEYS.RESELLERS) || [], found = false;
            for (var i = 0; i < resellers.length; i++) {
                if (String(resellers[i].id) !== String(resellerId)) continue;
                resellers[i].balance = (Number(resellers[i].balance) || 0) + amount;
                resellers[i].totalEarning = (Number(resellers[i].totalEarning) || 0) + amount;
                found = true;
                break;
            }
            if (!found) return { ok: false, message: 'Reseller account পাওয়া যায়নি।' };
            setData(DB_KEYS.RESELLERS, resellers);
            addTransaction(resellerId, 'credit', amount, note + ' / +৳' + amount + ' / Ref: ' + ref, 'offer_reward');
            /* stamp the unique reference onto the ledger row we just created */
            try {
                var tx = getData(DB_KEYS.TRANSACTIONS) || [];
                for (var t = 0; t < tx.length; t++) {
                    if (tx[t].resellerId === resellerId && tx[t].source === 'offer_reward' && !tx[t].ref) {
                        tx[t].ref = ref; tx[t].offerId = o.id;
                        break;
                    }
                }
                setData(DB_KEYS.TRANSACTIONS, tx);
            } catch (e) {}
        }

        /* ---- record the claim (single write, after the money moved) ---- */
        patchOfferState(offerId, resellerId, {
            claimed: true, claimedAt: new Date().toISOString(),
            rewardRef: ref, rewardMethod: isCash ? 'cash' : (isTrial ? 'free_trial' : 'link'),
            rewardAmount: isCash ? (Number(o.rewardAmount) || 0) : 0,
            rewardTrialDays: isTrial ? (Number(o.rewardTrialDays) || 0) : 0,
            completedAt: new Date().toISOString()
        });
        /* keep the offer's own counter in step (derived value is authoritative) */
        try {
            var offers = getOffers();
            for (var k = 0; k < offers.length; k++) {
                if (String(offers[k].id) === String(offerId)) { offers[k].claimsUsed = offerClaimsUsed(offers[k]); break; }
            }
            saveOffers(offers);
        } catch (e) {}

        try {
            addNotification(resellerId, 'offer',
                '🎁 Offer reward claimed — ' + (o.title || ('Offer #' + o.id)) +
                (isCash ? ' (+৳' + (Number(o.rewardAmount) || 0) + ')' : ''), true);
        } catch (e) {}
        try { logActivity('offer_claimed', 'Reseller #' + resellerId + ' claimed offer #' + offerId + ' (' + ref + ')'); } catch (e) {}

        return {
            ok: true, ref: ref, method: isCash ? 'cash' : 'link',
            amount: isCash ? (Number(o.rewardAmount) || 0) : 0,
            link: isCash ? '' : safeUrl(o.rewardLink),
            message: isCash ? ('৳' + (Number(o.rewardAmount) || 0) + ' আপনার wallet-এ যোগ হয়েছে।') : 'Reward claim হয়েছে।'
        };
    } finally {
        offerClaimLock[key] = false;
    }
}

/* ---------- admin aggregates ---------- */
function offerStats(offerId) {
    var o = getOfferById(offerId);
    if (!o) return null;
    var rows = offerStatesOfOffer(offerId);
    var started = 0, claimed = 0, completed = 0;
    for (var i = 0; i < rows.length; i++) {
        if (!rows[i]) continue;
        if (rows[i].startedAt) started++;
        if (rows[i].claimed) claimed++;
    }
    return {
        started: started, claimed: claimed,
        used: offerClaimsUsed(o),
        limit: Number(o.claimLimit) || 0,
        excluded: (o.excludedResellers || []).length,
        banners: offerBannerIds(o).length
    };
}
/* Offers relevant to one reseller, newest first */
function offersForReseller(resellerId) {
    var list = getOffers(), out = [];
    for (var i = 0; i < list.length; i++) {
        if (!list[i]) continue;
        if (!offerVisibleTo(list[i], resellerId)) continue;
        out.push(list[i]);
    }
    out.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    return out;
}
/* Banners the reseller dashboard should show: banners attached to offers that
   are still live for THIS reseller, plus standalone active banners. */
function dashboardBannersFor(resellerId) {
    var out = [], seen = {};
    var offers = offersForReseller(resellerId);
    for (var i = 0; i < offers.length; i++) {
        var st = offerStatusFor(offers[i], resellerId);
        if (st === 'claimed' || st === 'expired' || st === 'closed' || st === 'limit_reached' || st === 'not_eligible') continue;
        var bs = offerBanners(offers[i]);
        for (var j = 0; j < bs.length; j++) {
            if (seen[String(bs[j].id)]) continue;
            seen[String(bs[j].id)] = true;
            out.push({ banner: bs[j], offerId: offers[i].id });
        }
    }
    /* standalone banners (not attached to any offer) */
    var all = activeBanners();
    var attached = {};
    var allOffers = getOffers();
    for (var k = 0; k < allOffers.length; k++) {
        var ids = offerBannerIds(allOffers[k]);
        for (var m = 0; m < ids.length; m++) attached[String(ids[m])] = true;
    }
    for (var n = 0; n < all.length; n++) {
        if (attached[String(all[n].id)]) continue;
        if (seen[String(all[n].id)]) continue;
        seen[String(all[n].id)] = true;
        out.push({ banner: all[n], offerId: null });
    }
    return out;
}

/* ==========================================================================
   PLATFORM UPDATE — product ownership, catalog isolation, order routing,
   reseller categories, tickets and messaging.
   --------------------------------------------------------------------------
   This is still a 100% client-side app, so "backend level" rules are enforced
   in this data layer (the strongest persistence available here) and every
   list/query helper takes an explicit owner id. See the report for the
   server-side work required before production.
   ========================================================================== */

/* ---------- PART 1: product images (1..10) ---------- */
var PRODUCT_MAX_IMAGES = 10;
function productImages(p) {
    if (!p) return [];
    var out = [];
    if (Object.prototype.toString.call(p.images) === '[object Array]') {
        for (var i = 0; i < p.images.length; i++) { if (p.images[i]) out.push(rhImgUrl(String(p.images[i])) || String(p.images[i])); }
    }
    if (!out.length && p.image) out.push(rhImgUrl(String(p.image)) || String(p.image));
    return out;
}
function productPrimaryImage(p) {
    var imgs = productImages(p);
    if (!imgs.length) return '';
    var pi = p && p.primaryImage ? String(p.primaryImage) : '';
    if (pi) { for (var i = 0; i < imgs.length; i++) { if (imgs[i] === pi) return pi; } }
    /* pi may still be an unresolved ref while the IndexedDB cache is loading */
    if (rhImgIsRef(pi)) { var ru = rhImgUrl(pi); if (ru) return ru; }
    return imgs[0];
}
function setProductImages(p, list) {
    if (!p) return;
    var arr = [];
    for (var i = 0; i < list.length && arr.length < PRODUCT_MAX_IMAGES; i++) {
        if (list[i]) arr.push(String(list[i]));
    }
    p.images = arr;
    p.image = arr.length ? arr[0] : '';       /* keep the legacy single field in sync */
    if (!p.primaryImage || arr.indexOf(String(p.primaryImage)) === -1) p.primaryImage = arr.length ? arr[0] : '';
}
function productImageCount(p) { return productImages(p).length; }

/* ---------- PART 9, 10: size + variant model ----------
   variants: [{ name, color, size, stock, price, sku, image }] */
function productVariants(p) {
    if (!p) return [];
    var v = p.variants;
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
}
function productSizes(p) {
    if (!p) return [];
    var out = [], seen = {};
    if (Object.prototype.toString.call(p.sizes) === '[object Array]') {
        for (var i = 0; i < p.sizes.length; i++) {
            var s = String(p.sizes[i] || '').trim();
            if (s && !seen[s]) { seen[s] = 1; out.push(s); }
        }
    }
    var vs = productVariants(p);
    for (var j = 0; j < vs.length; j++) {
        var sz = String(vs[j].size || '').trim();
        if (sz && !seen[sz]) { seen[sz] = 1; out.push(sz); }
    }
    return out;
}
function productColors(p) {
    if (!p) return [];
    var out = [], seen = {};
    if (Object.prototype.toString.call(p.colors) === '[object Array]') {
        for (var i = 0; i < p.colors.length; i++) {
            var c = String(p.colors[i] || '').trim();
            if (c && !seen[c]) { seen[c] = 1; out.push(c); }
        }
    }
    var vs = productVariants(p);
    for (var j = 0; j < vs.length; j++) {
        var cl = String(vs[j].color || '').trim();
        if (cl && !seen[cl]) { seen[cl] = 1; out.push(cl); }
    }
    return out;
}
/* A variant grid only takes over stock control once per-variant quantities have
   actually been captured (`variantStockSet`) or at least one variant has stock.
   Otherwise the product-level `stock` stays authoritative. This is the root-cause
   fix for "product with variants can never be ordered": an empty/blank variant
   grid used to sum to 0, zeroing the product and blocking every order. */
function productVariantsActive(p) {
    var vs = productVariants(p);
    if (!vs.length) return false;
    if (p.variantStockSet === true) return true;
    for (var i = 0; i < vs.length; i++) { if ((Number(vs[i].stock) || 0) > 0) return true; }
    return false;
}
function markVariantStockSet(p, on) { if (p) p.variantStockSet = !!on; }

function syncProductStock(p) {
    if (!p) return p;
    if (productVariantsActive(p)) {
        var vs = productVariants(p), t = 0;
        for (var i = 0; i < vs.length; i++) t += Number(vs[i].stock) || 0;
        p.stock = t;
    }
    return p;
}
/* PART 20, 21 — availability uses variant stock when variants exist. */
function productInStock(p) {
    if (!p) return false;
    if (p.is_active === false) return false;
    if (productVariantsActive(p)) {
        var vs = productVariants(p);
        for (var i = 0; i < vs.length; i++) { if ((Number(vs[i].stock) || 0) > 0) return true; }
        return false;
    }
    return (Number(p.stock) || 0) > 0;
}
/* NOTE: the duplicate validateVariantSelection() that used to live here was removed —
   it shadowed the shared guard above (function declarations hoist, last one wins) and
   silently broke EVERY variant order. The shared guard now covers variant-level
   stock + existence, so no second implementation is needed. */

/* Stock of one concrete selection (used when placing an order). */
function variantStockFor(p, size, color) {
    if (!productVariantsActive(p)) return Number(p && p.stock) || 0;
    var vs = productVariants(p);
    for (var i = 0; i < vs.length; i++) {
        var v = vs[i];
        if (size && String(v.size || '') !== String(size)) continue;
        if (color && String(v.color || '') !== String(color)) continue;
        return Number(v.stock) || 0;
    }
    return 0;
}
/* Price of one concrete selection — variant price when the grid is active. */
function variantPriceFor(p, size, color) {
    if (!p) return 0;
    if (productVariantsActive(p)) {
        var vs = productVariants(p);
        for (var i = 0; i < vs.length; i++) {
            var v = vs[i];
            if (size && String(v.size || '') !== String(size)) continue;
            if (color && String(v.color || '') !== String(color)) continue;
            if (Number(v.price) > 0) return Number(v.price);
        }
    }
    return Number(p.customer_price) || Number(p.reseller_price) || Number(p.price) || 0;
}
/* Stable id of ONE concrete selection (#18). Every page must build it the same
   way, otherwise the same variant becomes two different line items. */
function variantIdFor(p, size, color) {
    var pid = (p && p.id !== undefined && p.id !== null) ? p.id : '';
    return String(pid) + '|' + (size || '-') + '|' + (color || '-');
}
/* Same id rebuilt from an already-stored order line (works for legacy rows). */
function itemVariantId(it) {
    if (!it) return '';
    if (it.variant_id) return String(it.variant_id);
    return variantIdFor({ id: it.productId }, it.size || '', it.color || '');
}
/* Two ids that differ only by an empty size/colour suffix mean the same
   selection: "104" and "104|-|-" are both the plain product. Needed because
   very old cart rows stored just the product id. */
function sameVariantId(a, b) {
    function norm(v) { return String(v || '').replace(/\|-(\|-)?$/, ''); }
    return norm(a) === norm(b);
}
/* ---------------------------------------------------------------------------
   One order line, built once, built right (#18, #19).
   Every order-creation path (Add New Order, Buy Now, Add to Cart, Checkout)
   must go through here so the historical fields are always present:
     product_source · product_owner_type · product_owner_id · shop_id
     product_id · variant_id · cost_price_at_order-equivalent · selling price
   `sellingPrice` may be passed when the reseller typed their own resale value;
   otherwise the customer-facing price of the exact variant is frozen.
   --------------------------------------------------------------------------- */
function makeOrderLine(p, size, color, qty, sellingPrice) {
    if (!p) return null;
    var own = productOwnerType(p) === 'reseller';
    var vPrice = variantPriceFor(p, size, color);
    var sell = (sellingPrice === undefined || sellingPrice === null || sellingPrice === '')
        ? vPrice
        : (Number(sellingPrice) || 0);
    /* Cost = what THIS reseller actually pays.
       Own uploaded product -> the cost they entered.
       Admin / supplier product -> the wholesale price charged to them. */
    var cost = own
        ? (Number(p.cost) || Number(p.buy_price) || 0)
        : (Number(p.reseller_price) || Number(p.price) || 0);
    var wholesale = Number(p.reseller_price) || Number(p.price) || 0;
    return {
        productId: p.id,
        product_id: p.id,
        variant_id: variantIdFor(p, size, color),
        name: p.name,
        image: p.image || '',
        icon: p.icon || 'fa-box',
        sku: p.sku || '',
        size: size || '',
        color: color || '',
        qty: Math.max(1, Number(qty) || 1),
        variant_price: vPrice,
        selling_price: sell,
        cost_price: cost,
        price: wholesale,      // legacy field many old views still read
        resale: sell,         // legacy field = customer-facing price
        product_source: productOwnerType(p),
        product_owner_type: productOwnerType(p),
        product_owner_id: productOwnerId(p),
        shop_id: own ? productOwnerId(p) : null
    };
}
function deductVariantStock(p, size, color, qty) {
    if (!p) return;
    if (!productVariantsActive(p)) {
        p.stock = Math.max(0, (Number(p.stock) || 0) - (Number(qty) || 0));
        return;
    }
    var vs = productVariants(p);
    for (var i = 0; i < vs.length; i++) {
        var v = vs[i];
        if (size && String(v.size || '') !== String(size)) continue;
        if (color && String(v.color || '') !== String(color)) continue;
        v.stock = Math.max(0, (Number(v.stock) || 0) - (Number(qty) || 0));
        break;
    }
    syncProductStock(p);
}

/* ---------- PART 11, 13: YouTube (validated, never raw-injected) ---------- */
function parseYouTubeId(url) {
    var u = String(url || '').trim();
    if (!u) return '';
    var m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(u)) return u;
    return '';
}
function youtubeEmbedUrl(url) {
    var id = parseYouTubeId(url);
    return id ? ('https://www.youtube-nocookie.com/embed/' + id) : '';
}
function youtubeWatchUrl(url) {
    var id = parseYouTubeId(url);
    return id ? ('https://www.youtube.com/watch?v=' + id) : '';
}

/* ---------- PART 3, 5, 6, 48, 51, 52: catalog isolation ---------- */
function isResellerProduct(p) { return productOwnerType(p) === 'reseller'; }
function isCatalogProduct(p) {
    /* admin + supplier products only, and only when actually available */
    if (!p) return false;
    if (isResellerProduct(p)) return false;                 /* PART 6 */
    if (p.supplierId && p.approved === false) return false; /* existing approval rule */
    if (!productInStock(p)) return false;                   /* PART 20, 21 */
    return true;
}
/* Main platform catalog — PART 6, 48, 52 */
function catalogProducts() {
    var ps = getData(DB_KEYS.PRODUCTS) || [], out = [];
    for (var i = 0; i < ps.length; i++) if (isCatalogProduct(ps[i])) out.push(ps[i]);
    return out;
}
/* What a reseller sees in their own "All Products" browsing list (same set). */
function resellerCatalogProducts(rid) { return catalogProducts(); }

/* ---------- PART 4, 5, 51: order routing ---------- */
/* An order is "own product" for a reseller when at least one line item is one
   of THEIR My Shop products. Pure platform orders stay in All Orders. */
function orderTypeOf(o, rid) {
    if (!o) return 'platform';
    if (rid !== undefined && rid !== null && orderHasOwnProduct(o, rid)) return 'reseller_own';
    if (o.order_type) return String(o.order_type);
    /* fall back to inspecting the line items against every reseller product */
    if (o.items && o.items.length) {
        for (var i = 0; i < o.items.length; i++) {
            var it = o.items[i] || {};
            if (it.product_owner_type === 'reseller') return 'reseller_own';
            var p = findProductById(it.productId);
            if (p && isResellerProduct(p)) return 'reseller_own';
        }
    }
    return 'platform';
}
/* Does the order contain at least one admin/supplier product line? */
function orderHasCatalogProduct(o) {
    if (!o) return false;
    if (o.items && o.items.length) {
        for (var i = 0; i < o.items.length; i++) {
            var it = o.items[i] || {};
            if (it.product_owner_type === 'reseller') continue;
            var p = findProductById(it.productId);
            if (!p || !isResellerProduct(p)) return true;
        }
        return false;
    }
    var p2 = findProductById(o.productId);
    return !!(p2 && !isResellerProduct(p2));
}
/* PART 3 — Reseller "All Orders" = admin + supplier product orders only. */
function resellerAllOrders(rid) {
    var orders = getData(DB_KEYS.ORDERS) || [], out = [];
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o) continue;
        /* ownership may live in resellerId / reseller_id / shop_id — resolve it
           all, otherwise a real order silently disappears from the owner's list */
        if (!orderBelongsToReseller(o, rid)) continue;
        /* A PURE own-product order is a My Shop order and belongs on the My Shop
           Orders page only. A MIXED order also has platform lines, so it stays
           here — and must never be dropped just because its `source` flag is
           missing (Add New Order writes mixed_source, not source). */
        if (isMyShopOrder(o) && !orderHasCatalogProduct(o)) continue;
        out.push(o);
    }
    return out;
}
/* PART 4 — Reseller "My Shop Orders" = only their OWN product orders. */
function resellerOwnProductOrders(rid) {
    var orders = getData(DB_KEYS.ORDERS) || [], out = [];
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o) continue;
        if (!orderBelongsToReseller(o, rid)) continue;
        if (orderHasOwnProduct(o, rid)) out.push(o);
    }
    return out;
}

/* =========================================================================
   SHARED ORDER-ROUTING / COUNTER / OFFER-SOURCE LAYER
   One source of truth for: "which page shows this order?", "how many orders
   does the sidebar badge show?", and "does this line count for an offer?"
   Recent Orders · Add New Order · All Orders · My Shop Orders · Offer Criteria
   all read from here so they can never disagree.
   ========================================================================= */

/* Statuses that count toward the "All Orders" sidebar badge (#3, #4).
   Only Pending + Confirmed. Packaging / Shipping / Shipped / Delivered /
   Returned / Cancelled / Rejected / Failed / WFR never count. */
/* (items 13-15) Sidebar "All Orders" counter = orders still sitting at the NEW
   stage. `new` is the actual status value written when an order is placed; a very
   early build also used `pending` for the same stage, so both are accepted and
   nothing else is. Anything further along the pipeline (confirmed / packaging /
   shipping / shipped / delivered / …) and anything terminal (cancel / cancelled /
   rejected / failed / returned) is NOT a new order and is not counted. */
var NEW_ORDER_STATUSES = ['new', 'pending'];
function orderIsNew(o) {
    if (!o) return false;
    var s = String(o.status || '').toLowerCase().trim();
    for (var i = 0; i < NEW_ORDER_STATUSES.length; i++) if (s === NEW_ORDER_STATUSES[i]) return true;
    return false;
}
/* Kept as the generic stage test used elsewhere in the app.
   NOTE: this used to reference a COUNTER_STATUSES constant that was removed when
   the counter definition was narrowed to NEW_ORDER_STATUSES (items 13-15), which
   made every call throw a ReferenceError. It now uses the same definition. */
/* (item 4, 2026-09-14) THE badge definition. The sidebar number is a
   NOTIFICATION, not a row count — the user's words: "কোনো অর্ডার যতক্ষণ নিউ থাকবে,
   কনফার্ম থাকবে, ততক্ষণ এই পপ আপ আইকনে লেখা থাকবে কতগুলো অর্ডার ... সাপ্লায়ার,
   অ্যাডমিন আর রিসেলার সবাই বুঝতে পারে যে তার কোনো নতুন অর্ডার আসছে".
   So it counts every order still WAITING on that role: New, Pending and
   Confirmed. It drops the moment the order moves on to packaging / shipping /
   shipped / delivered, or is cancelled / rejected / returned — i.e. the number
   goes down exactly when the role has acted on the order.
   `orderIsNew()` keeps its NARROWER meaning ("still at the very first stage") for
   the handful of callers that need precisely that; every badge counter below
   goes through orderCountsForBadge() instead, so the three panels can never
   disagree about what "an unread order" is. */
var BADGE_ORDER_STATUSES = ['new', 'pending', 'confirmed'];
function orderCountsForBadge(o) {
    if (!o) return false;
    var s = String(o.status === undefined || o.status === null ? '' : o.status).toLowerCase().trim();
    /* A MISSING status is deliberately NOT a badge order. This matches
       orderAwaitingResellerConfirm(), which also treats "no status" as "not
       awaiting" — such a row is a legacy order that has already been through the
       pipeline, and it is listed in All Orders without lighting up the badge.
       Checked BEFORE the normaliser, because orderStageKey() defaults a missing
       status to 'new' for DISPLAY purposes. */
    if (!s) return false;
    /* 2026-09-15 — normalise the rest through the canonical orderStageKey(). The
       product-wise summary (productSummaryStatusIncluded) covers the same three
       statuses and normalises, so comparing RAW here made the two disagree on a
       legacy spelling: a 'processing' order (an ORDER_STAGE_ALIAS entry meaning
       'new') counted in the summary but not on the badge. Same vocabulary, same
       answer. 'shipped' -> 'shipping' and 'pending' -> 'new' change nothing. */
    if (typeof orderStageKey === 'function') { try { s = orderStageKey(s); } catch (e) {} }
    for (var i = 0; i < BADGE_ORDER_STATUSES.length; i++) if (s === BADGE_ORDER_STATUSES[i]) return true;
    return false;
}

/* (#1, #2, #19) Which page must the "View" button open for this order?
   Order-item level ownership wins; a mixed order that contains ANY of this
   reseller's own product is a My Shop order, because that is where the
   reseller can act on it. Admin/supplier-only orders go to All Orders. */
function resellerOrderViewTarget(o, rid) {
    if (!o) return 'my-orders.html';
    if (orderHasOwnProduct(o, rid)) return 'my-shop-orders.html';
    return 'my-orders.html';
}
function resellerOrderViewUrl(o, rid) {
    /* deep-link so the destination page can highlight the row */
    return resellerOrderViewTarget(o, rid) + '?order=' + encodeURIComponent(String(o && o.id !== undefined ? o.id : ''));
}
/* Shared query-param reader (#19) — one implementation for every page, so the
   Recent Orders -> View deep link opens the exact order without any hardcoded
   id living in the HTML. Returns '' when absent. */
function queryParam(name) {
    try {
        var m = String((window.location && window.location.search) || '').match(
            new RegExp('[?&]' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^&]*)')
        );
        return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
    } catch (e) { return ''; }
}
/* Highlight + scroll to the order named in ?order=. Safe no-op if not found. */
function focusOrderRow(orderId) {
    if (!orderId) return;
    try {
        var el = document.querySelector('[data-order-id="' + String(orderId).replace(/"/g, '\\"') + '"]');
        if (!el) return;
        el.style.outline = '2px solid #6366f1';
        el.style.outlineOffset = '2px';
        el.style.transition = 'outline-color .4s';
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e2) { el.scrollIntoView(); }
        setTimeout(function () { try { el.style.outline = ''; } catch (e3) {} }, 3500);
    } catch (e) { /* non-fatal */ }
}

/* (items 13-15, item 4) New-order counts, ownership-scoped.
   Derived from EXACTLY the list function the page renders — resellerAllOrders()
   — so the number on the sidebar can never disagree with the rows on the page,
   and it can never leak another tenant's orders.
   It previously re-implemented the filter inline with a DIFFERENT predicate
   (orderHasOwnProduct) than the list uses (isMyShopOrder && !orderHasCatalogProduct),
   so a MIXED order — an own-product line plus a catalog line — appeared in the
   list but was NOT counted by the badge. Delegating removes that drift for good. */
function resellerNewOrderCount(rid) {
    return countBadges(resellerAllOrders(rid));
}
function adminNewOrderCount() {
    /* Derived from the SAME predicate the Admin -> All Orders list renders
       (`adminNormalOrders`), so the sidebar number can never disagree with the
       rows on the page — the same rule `resellerNewOrderCount` already follows.
       It used to count EVERY new/pending order, including My Shop
       (reseller-owned) ones. Those are deliberately routed to Admin -> My Shop
       Orders, so with only My Shop orders present the badge showed a number
       while All Orders was correctly empty ("no orders shown but the
       notification says 1"). */
    var list = adminNormalOrders(), n = 0;
    for (var i = 0; i < list.length; i++) if (orderCountsForBadge(list[i])) n++;
    return n;
}
function supplierNewOrderCount(sid) {
    var all = getData(DB_KEYS.ORDERS) || [], n = 0;
    for (var i = 0; i < all.length; i++) {
        var o = all[i];
        if (!o || !orderCountsForBadge(o)) continue;      /* item 4: New + Confirmed */
        var items = orderLineItems(o), hit = false;
        for (var j = 0; j < items.length; j++) {
            var it = items[j] || {};
            if (it.supplierId !== undefined && it.supplierId !== null && it.supplierId !== '' && String(it.supplierId) === String(sid)) { hit = true; break; }
            var p = findProductById(it.productId);
            if (p && p.supplierId !== undefined && p.supplierId !== null && String(p.supplierId) === String(sid)) { hit = true; break; }
        }
        if (hit) n++;
    }
    return n;
}
/* (#3, #6 / items 13-15 / item 4) Sidebar badge number — ownership-scoped, never
   leaking another tenant's orders. Item 4 widened it from "still at the NEW stage"
   to "still waiting on this role" = New + Pending + Confirmed, and it is now the
   SAME function as resellerNewOrderCount() so the two names cannot drift. */
function resellerOrderBadgeCount(rid) {
    return resellerNewOrderCount(rid);
}
function adminOrderBadgeCount() {
    /* Alias of adminNewOrderCount() so there is exactly ONE definition of
       "how many orders does the All Orders badge show". It previously counted
       every new/pending order regardless of routing, which made the Admin
       dashboard's orders badge disagree with the All Orders list for the same
       reason (My Shop orders are routed to Admin -> My Shop Orders). */
    return adminNewOrderCount();
}
/* Supplier All Orders badge = orders that contain at least one of THIS
   supplier's products, at New/Pending/Confirmed.
   Derived from supplierOrders() — the very same source the supplier's All Orders
   page reads (via myOrders() -> allOrdersList()) — and it skips MULTI-SUPPLIER
   orders for the same reason that page does: those are collected by the platform,
   live on the Multi-Supplier page and carry their own badge
   (supplierMultiOrderBadgeCount / #muBadge). Counting them here as well would
   double-notify for one order. */
function supplierOrderBadgeCount(sid) {
    var list = supplierOrders(sid), n = 0;
    for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (!o || !orderCountsForBadge(o)) continue;
        if (typeof isMultiSupplierOrder === 'function' && isMultiSupplierOrder(o)) continue;
        n++;
    }
    return n;
}

/* ---------------------------------------------------------------------------
   ITEM 4 (spec, 2026-09-14) — "যেখানে All Orders, My Shop Order, Total Orders,
   যেই অর্ডারই থাক না কেন, সেইখানে যে পপ আপ একটা নাম্বার দেখায় ... এটা কিন্তু
   মাল্টি সাপ্লায়ার অর্ডারের ক্ষেত্রেও এই জিনিসটা করবে।"
   Every ORDER LIST gets its own notification badge, and each badge is derived
   from EXACTLY the list its page renders (same predicate, same function) so the
   number can never disagree with the rows underneath it:
       reseller  All Orders          -> resellerNewOrderCount()        [non-own-product]
       reseller  My Shop Orders      -> resellerMyShopOrderBadgeCount() [own-product]
       admin     All Orders          -> adminNewOrderCount()            [adminNormalOrders]
       admin     My Shop Orders      -> adminMyShopOrderBadgeCount()    [adminMyShopOrders]
       admin     Multi-Supplier      -> adminMultiSupplierBadgeCount()  [multiSupplierOrders]
       supplier  All Orders          -> supplierOrderBadgeCount()       [own lines]
       supplier  Multi-Supplier      -> supplierMultiOrderBadgeCount()  [own multi orders]
   --------------------------------------------------------------------------- */
function countBadges(list) {
    var n = 0;
    for (var i = 0; i < (list || []).length; i++) if (orderCountsForBadge(list[i])) n++;
    return n;
}
function resellerMyShopOrderBadgeCount(rid) { return countBadges(resellerOwnProductOrders(rid)); }
function adminMyShopOrderBadgeCount() { return countBadges(adminMyShopOrders()); }

/* PRODUCTS PENDING APPROVAL (2026-09-15) — how many supplier-uploaded products
   are waiting for the admin. Decreases as the admin approves them, so the badge
   on the admin sidebar's Products item is a live work queue. One definition, so
   admin/products.html and the nav badge can never disagree. */
function adminPendingProductCount() {
    var n = 0;
    try {
        var ps = getData(DB_KEYS.PRODUCTS) || [];
        for (var i = 0; i < ps.length; i++) {
            if (!ps[i]) continue;
            if (ps[i].supplierId && ps[i].approved === false) n++;
        }
    } catch (e) { return 0; }
    return n;
}
/* Pending withdrawal requests — resellers and suppliers separately. A request
   leaves the queue the moment it is approved or rejected, so the badge counts
   only what is still waiting. */
function pendingResellerWithdrawalCount() {
    var n = 0;
    try {
        var ws = getData(DB_KEYS.WITHDRAWALS) || [];
        for (var i = 0; i < ws.length; i++) {
            var s = String((ws[i] || {}).status || 'pending').toLowerCase();
            if (s !== 'approved' && s !== 'completed' && s !== 'rejected') n++;
        }
    } catch (e) { return 0; }
    return n;
}
function pendingSupplierWithdrawalCount() {
    var n = 0;
    try {
        var sups = getData(DB_KEYS.SUPPLIERS) || [];
        for (var i = 0; i < sups.length; i++) {
            var pays = [];
            try { pays = JSON.parse(localStorage.getItem('rh_payouts_' + sups[i].id) || '[]'); } catch (e) { pays = []; }
            for (var j = 0; j < pays.length; j++) {
                var s = String((pays[j] || {}).status || 'pending').toLowerCase();
                if (s !== 'approved' && s !== 'completed' && s !== 'rejected') n++;
            }
        }
    } catch (e) { return 0; }
    return n;
}
function adminMultiSupplierBadgeCount() { return countBadges(multiSupplierOrders()); }
function supplierMultiOrderBadgeCount(sid) { return countBadges(multiSupplierOrdersFor(sid)); }

/* ---------------------------------------------------------------------------
   One self-installing painter for the badges that no page script owns.
   Written here (rather than in 50+ copied inline blocks) so the rule lives in
   ONE place. It only ever ADDS a badge to an order-list nav item that does not
   already have one, and it never overwrites a badge an inline script manages —
   so it cannot fight with the existing per-page paint() code.
   --------------------------------------------------------------------------- */
var RH_BADGE_STYLE = 'display:none;margin-left:auto;background:#ef4444;color:#fff;border-radius:10px;padding:1px 7px;font-size:.62rem;font-weight:800';
function rhBadgeHost(hrefEnd) {
    try {
        var links = document.querySelectorAll('a[href]'), best = null;
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var h = String(a.getAttribute('href') || '').split('?')[0];
            if (h !== hrefEnd && h.slice(-hrefEnd.length - 1) !== '/' + hrefEnd) continue;
            if (!best) best = a;
            /* Prefer the link that lives in the navigation chrome. Several pages
               carry a decorative "My Shop Orders →" shortcut inside a page card,
               and appending the badge there would put the notification in the
               middle of the content instead of on the nav item. */
            if (a.closest && a.closest('.sidebar,.lx-sidebar,.smenu,aside,nav,.sidebar-menu')) return a;
        }
        return best;
    } catch (e) {}
    return null;
}
function rhPaintBadgeInto(host, id, n) {
    if (!host) return null;
    var el = document.getElementById(id);
    if (!el) {
        el = document.createElement('span');
        el.id = id;
        el.className = 'rh-orders-badge';
        el.setAttribute('style', RH_BADGE_STYLE);
        host.appendChild(el);
    }
    el.textContent = n;
    el.style.display = n > 0 ? 'inline-block' : 'none';
    return el;
}

/* CREATE-OR-UPDATE painter for the "Customer Messages" nav item.
   `rhPaintBadgeInto()` is create-ONLY (it bails out when the id already
   exists) and 17 reseller pages already ship a `<span id="cmsgBadgeLabel">`
   slot inside the label, so it cannot be reused here. The red pill is appended
   to the SAME <a> that the sidebar CSS already lays out as a flex row — exactly
   how the "All Orders" pill behaves — so it needs no per-page CSS. */
function rhPaintCustomerMessageBadge(uid) {
    var a = rhBadgeHost('customer-messages.html');
    if (!a) return null;
    var pill = document.getElementById('cmsgBadge');
    if (!pill) {
        pill = document.createElement('span');
        pill.id = 'cmsgBadge';
        pill.className = 'rh-cmsg-badge';
        pill.setAttribute('style', RH_BADGE_STYLE);
        a.appendChild(pill);
    }
    var n = 0;
    try { n = (typeof resellerCustomerMessageBadgeCount === 'function') ? resellerCustomerMessageBadgeCount(uid) : 0; } catch (e) { n = 0; }
    pill.textContent = n;
    pill.style.display = n > 0 ? 'inline-block' : 'none';
    /* The old gold " (n)" slot counted MESSAGES. Now that the pill counts
       CUSTOMERS, leaving both on one row would print two different numbers,
       so the slot is cleared and this painter owns the number. */
    var lbl = document.getElementById('cmsgBadgeLabel');
    if (lbl && lbl.textContent) lbl.textContent = '';
    return pill;
}
function rhPaintOrderBadges() {
    var uid = '', type = '';
    try { uid = sessionStorage.getItem('user_id') || ''; type = sessionStorage.getItem('user_type') || ''; } catch (e) { return; }
    if (!uid || !type) return;
    try {
        if (type === 'reseller') {
            /* All Orders — 10 of the 17 reseller pages that carry this nav item
               were missing the red pill entirely (their copy of the sidebar kept
               only the yellow " (n)" text), so on those pages the notification
               was easy to miss. The pill is created here, with inline styles so
               it needs no per-page CSS, and only when the page does not already
               render one. */
            var aHost = rhBadgeHost('my-orders.html');
            if (aHost && !document.getElementById('ordersBadge')) {
                var pill = document.createElement('span');
                pill.id = 'ordersBadge';
                pill.className = 'rh-orders-badge';
                pill.setAttribute('style', RH_BADGE_STYLE);
                aHost.appendChild(pill);
            }
            rhPaintBadgeInto(aHost, 'ordersBadge',
                (typeof resellerNewOrderCount === 'function') ? resellerNewOrderCount(uid) : 0);
            /* My Shop Orders — this reseller's OWN uploaded products only. */
            rhPaintBadgeInto(rhBadgeHost('my-shop-orders.html'), 'mshopBadge',
                (typeof resellerMyShopOrderBadgeCount === 'function') ? resellerMyShopOrderBadgeCount(uid) : 0);
            rhPaintCustomerMessageBadge(uid);
        } else if (type === 'admin') {
            rhPaintBadgeInto(rhBadgeHost('myshop-orders.html'), 'mshopBadge',
                (typeof adminMyShopOrderBadgeCount === 'function') ? adminMyShopOrderBadgeCount() : 0);
            /* Products waiting for approval — the admin's live work queue.
               Falls to 0 as products are approved. */
            rhPaintBadgeInto(rhBadgeHost('products.html'), 'prodPendBadge', adminPendingProductCount());
            /* Pending withdrawal requests, resellers and suppliers separately. */
            rhPaintBadgeInto(rhBadgeHost('withdrawals.html'), 'wdBadge', pendingResellerWithdrawalCount());
            rhPaintBadgeInto(rhBadgeHost('supplier-withdrawals.html'), 'supWdBadge', pendingSupplierWithdrawalCount());
            /* #msCount is the admin sidebar's own slot for the Multi-Supplier list.
               It used to be filled ONLY while that page was open, so the admin got
               no notification for a new multi-supplier order from anywhere else. */
            var mn = (typeof adminMultiSupplierBadgeCount === 'function') ? adminMultiSupplierBadgeCount() : 0;
            var mc = document.getElementById('msCount');
            if (mc) mc.textContent = mn > 0 ? (' (' + mn + ')') : '';
        } else if (type === 'supplier') {
            /* The supplier sidebar's own <a> elements are data-p driven and carry
               no href, so these two badges are addressed by id. */
            var on = (typeof supplierOrderBadgeCount === 'function') ? supplierOrderBadgeCount(uid) : 0;
            var oe = document.querySelector('.smenu a[data-p="orders"] .orders-badge');
            if (oe) { oe.textContent = on; oe.style.display = on > 0 ? 'inline-block' : 'none'; }
            var mu = (typeof supplierMultiOrderBadgeCount === 'function') ? supplierMultiOrderBadgeCount(uid) : 0;
            var mb = document.getElementById('muBadge');
            if (mb) { mb.textContent = mu; mb.style.display = mu > 0 ? 'inline-block' : 'none'; }
        }
    } catch (e) { /* a badge must never break the page */ }
}
function rhInstallOrderBadges() {
    rhPaintOrderBadges();
    /* ITEM 6 — the same hook applies the admin's per-reseller upload switch, so
       every reseller page obeys it without a single per-page edit. */
    try { rhApplyShopUploadPolicy(); } catch (e) {}
    /* 2026-09-18 — the same hook paints the premium locks, so all 27 reseller
       pages obey the rule with no per-page edits. No-ops for admin/supplier. */
    try { rhPremiumBoot(); } catch (e) {}
    /* ...and adds the Premium entry to every admin sidebar. No-ops elsewhere. */
    try { rhInjectAdminPremiumNav(); } catch (e) {}
    /* 2026-09-18 — the Customer Information entry: the reseller's own sidebar and
       the admin's. Each no-ops on a page without the matching menu. */
    try { rhInjectCustomerInfoNav(); } catch (e) {}
    try { rhInjectAdminCustomerInfoNav(); } catch (e) {}
    /* 2026-09-18 — one fixed home for the Shop Categories row, on every panel page */
    try { rhNormaliseShopCategoriesNav(); } catch (e) {}
    /* ORDER MATTERS: rhPremiumBoot() above painted the premium badges BEFORE these
       rows existed, so the new Customer Information item would have carried no
       lock badge. Paint once more now that it is in the DOM — rhApplyPremiumLock()
       removes its own previous badge first, so this can never stack two. */
    try { rhApplyPremiumLock(); } catch (e) {}
    try {
        window.addEventListener('storage', function (e) {
            if (!e.key || e.key.indexOf('rh_orders') === 0 || e.key === 'rh_db_version' || e.key.indexOf('rh_shop_chats') === 0) rhPaintOrderBadges();
            if (!e.key || e.key.indexOf('rh_shop_settings') === 0) { try { rhApplyShopUploadPolicy(); } catch (e2) {} }
        });
    } catch (e) {}
}
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rhInstallOrderBadges);
    else rhInstallOrderBadges();
}
/* (#7, #8, #9) Offer criteria may ONLY be satisfied by admin / supplier
   products. A reseller-uploaded product never counts — historically stored
   source wins, the product row is only a fallback for very old orders. */
function offerEligibleLine(it) {
    if (!it) return false;
    var src = String(it.product_source || it.product_owner_type || it.productOwnerType || '');
    if (src === 'reseller') return false;                 /* explicit: never eligible */
    if (src === 'admin' || src === 'supplier' || src === 'platform') return true;
    var p = findProductById(it.productId);
    if (p) return productOwnerType(p) !== 'reseller';
    return true;                                          /* legacy platform line */
}
function orderOfferEligibleCount(o) {
    if (!o) return 0;
    var items = orderLineItems(o), n = 0;
    for (var i = 0; i < items.length; i++) if (offerEligibleLine(items[i])) n++;
    return n;
}
function orderOfferIneligibleCount(o) {
    var items = orderLineItems(o);
    return items.length - orderOfferEligibleCount(o);
}
/* One flag so every caller asks the same question: does this order advance an
   offer at all? An order made purely of the reseller's own products never does. */
function orderCountsForOffer(o) {
    return orderOfferEligibleCount(o) > 0;
}

/* =========================================================================
   MIXED-SOURCE ORDER SPLIT · OWNERSHIP GROUPING · DELIVERY ALLOCATION
   -------------------------------------------------------------------------
   The CUSTOMER always places ONE combined order and pays ONE delivery charge.
   Management side, the same order is VIEWED as ownership groups so each side
   fulfils only what it owns:
     · admin / supplier lines  -> catalog group (All Orders / supplier panel)
     · THIS reseller's own line-> own-product group (My Shop Orders)
   The delivery charge is never added twice: the catalog group carries the
   customer's delivery charge (+), the own-product group shows the matching
   negative adjustment (−), so the two groups reconcile exactly to the product
   subtotal. Field names come from the real line items; nothing is hardcoded.
   ========================================================================= */

/* Which group does one line belong to? 'own' = this reseller's own product,
   'catalog' = admin/supplier/platform product. */
function orderLineGroupKind(it, rid) {
    if (!it) return 'catalog';
    var t = String(it.product_owner_type || it.productOwnerType || '');
    var id = (it.product_owner_id !== undefined && it.product_owner_id !== null) ? it.product_owner_id : it.ownerResellerId;
    if (t === 'reseller') return (rid !== undefined && rid !== null && String(id) === String(rid)) ? 'own' : 'other_reseller';
    if (t === 'admin' || t === 'supplier' || t === 'platform') return 'catalog';
    if (id !== undefined && id !== null && id !== '') return (rid !== undefined && String(id) === String(rid)) ? 'own' : 'other_reseller';
    /* legacy row with no stored ownership -> fall back to the product record */
    var p = findProductById(it.productId);
    if (p && productOwnerType(p) === 'reseller') {
        return (rid !== undefined && isResellerOwnProduct(p, rid)) ? 'own' : 'other_reseller';
    }
    return 'catalog';
}

/* Split one order into ownership groups. Returns a plain structure the pages
   render — never a second order record (spec #15, #20: no duplicate system). */
function orderOwnershipGroups(o, rid) {
    var items = orderLineItems(o);
    var groups = { catalog: { kind: 'catalog', items: [] }, own: { kind: 'own', items: [] } };
    for (var i = 0; i < items.length; i++) {
        var kind = orderLineGroupKind(items[i], rid);
        if (kind === 'own') groups.own.items.push(items[i]);
        else if (kind === 'other_reseller') { /* never surfaced for this reseller */ }
        else groups.catalog.items.push(items[i]);
    }
    return groups;
}

/* Is this a mixed-source order (both a catalog part AND this reseller's own
   part)? Only then does the shared delivery adjustment apply (spec #10). */
function orderIsMixedSource(o, rid) {
    if (!o) return false;
    var g = orderOwnershipGroups(o, rid);
    return g.catalog.items.length > 0 && g.own.items.length > 0;
}

/* Customer-facing delivery charge actually charged on this order once. */
function orderDeliveryCharge(o) {
    if (!o) return 0;
    var v = Number(o.shippingCharge);
    if (!isNaN(v) && v) return v;
    var v2 = Number(o.deliveryCharge);
    return (!isNaN(v2) && v2) ? v2 : 0;
}

/* Sum of the customer selling price of the lines in one group. */
function groupSellingTotal(group) {
    if (!group || !group.items) return 0;
    var t = 0;
    for (var i = 0; i < group.items.length; i++) {
        var it = group.items[i] || {};
        t += itemSellingPrice(it) * (Number(it.qty) || 1);
    }
    return t;
}

/* Allocate the ONE delivery charge across groups so the customer's total is
   preserved exactly:
     catalog group = selling total + delivery        (৳600 + ৳70 = ৳670)
     own group     = selling total − delivery        (৳700 − ৳70 = ৳630)
   Only for mixed-source orders. A single-source order keeps its existing
   behaviour (adjustment 0) so nothing existing changes (spec #10). */
function orderGroupAllocation(o, rid) {
    var g = orderOwnershipGroups(o, rid);
    var mixed = orderIsMixedSource(o, rid);
    var delivery = mixed ? orderDeliveryCharge(o) : 0;
    var catSell = groupSellingTotal(g.catalog);
    var ownSell = groupSellingTotal(g.own);
    var out = {
        mixed: mixed,
        deliveryCharge: orderDeliveryCharge(o),
        catalogItems: g.catalog.items,
        ownItems: g.own.items,
        catalog: {
            sellingTotal: catSell,
            deliveryAllocation: mixed ? delivery : 0,
            adjustment: mixed ? delivery : 0,
            netAmount: catSell + (mixed ? delivery : 0)
        },
        own: {
            sellingTotal: ownSell,
            deliveryAllocation: mixed ? -delivery : 0,
            adjustment: mixed ? -delivery : 0,
            netAmount: ownSell - (mixed ? delivery : 0)
        }
    };
    return out;
}

/* The net amount this reseller is settled for on their OWN-product part of an
   order (selling − shared delivery adjustment, when the order is mixed).
   Cost/buying price is NEVER involved here (spec #8, #11). */
function ownGroupNetAmount(o, rid) {
    return orderGroupAllocation(o, rid).own.netAmount;
}
/* The catalog side's amount (selling + the single delivery charge) — the figure
   the supplier/admin fulfilment flow works with. */
function catalogGroupTotal(o, rid) {
    return orderGroupAllocation(o, rid).catalog.netAmount;
}
/* Profit of this reseller's own part, computed from the NET amount so the shared
   delivery adjustment is reflected, while historical cost/selling stay frozen. */
function ownGroupNetProfit(o, rid) {
    if (!profitEligibleOrder(o)) return 0;
    var alloc = orderGroupAllocation(o, rid);
    var gross = 0;
    for (var i = 0; i < alloc.ownItems.length; i++) {
        var it = alloc.ownItems[i] || {};
        gross += (itemSellingPrice(it) - itemCostPrice(it)) * (Number(it.qty) || 1);
    }
    /* the negative delivery adjustment reduces the own-side gross profit */
    return gross + alloc.own.adjustment;
}

/* ---------- PART 7, 8, 40, 41, 42: reseller own categories ---------- */
/* Shape: { [rid]: [ { id, name, icon, subs: [ { name, subSubs: [name,...] } ] } ] } */
function getAllOwnCategories() {
    var c = getData(DB_KEYS.SHOP_OWN_CATEGORIES);
    if (Object.prototype.toString.call(c) === '[object Array]') return {};
    return (c && typeof c === 'object') ? c : {};
}
function saveAllOwnCategories(obj) { setData(DB_KEYS.SHOP_OWN_CATEGORIES, obj); return obj; }
/* The UNGATED reader (2026-09-18). getOwnCategories() below hides the tree while a
   shop's premium is lapsed — correct for a READER (the nav then shows the admin
   catalogue only), but catastrophic for a WRITER.

   Every writer used to read through the gated reader, so on a shop whose premium
   was not open:
     · ownCategoryAdd()   read [] , pushed the new item and SAVED [] + item —
                          silently DELETING every own category the shop had;
     · ownCategoryRename()/ownCategoryRemove()/ownCategorySetHidden() could never
                          find their node, so Save and Delete did nothing at all.
   Writers must always see the real stored tree. */
function getOwnCategoriesRaw(rid) {
    var all = getAllOwnCategories();
    var list = all[String(rid)];
    return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
}
function getOwnCategories(rid) {
    /* 2026-09-18 — the reseller's own category structure is hidden while their
       premium/trial is lapsed; the nav shows the admin catalogue only. */
    try { if (!premiumShopOpen(rid)) return []; } catch (e) { }
    return getOwnCategoriesRaw(rid);
}
function saveOwnCategories(rid, list) {
    var all = getAllOwnCategories();
    all[String(rid)] = list;
    return saveAllOwnCategories(all);
}
function ownCategoryAdd(rid, name, parentSub) {
    name = String(name || '').trim();
    if (!name) return { ok: false, message: 'Category নাম দিন।' };
    var list = getOwnCategoriesRaw(rid);
    if (!parentSub) {
        for (var i = 0; i < list.length; i++) if (String(list[i].name).toLowerCase() === name.toLowerCase()) return { ok: false, message: 'এই category আগেই আছে।' };
        /* ITEM 8 — adding a main category that the ADMIN already has would be a
           second, invisible copy: shopMainCategories() dedupes by name and the
           global one always wins, so the reseller's "new" category would appear
           to do nothing. Refuse with a clear reason instead. */
        if (adminCategoryExists(name)) return { ok: false, message: 'এই main category Admin-এর তালিকায় আগেই আছে — নিচের তালিকা থেকে বেছে নিন।' };
        list.push({ id: 'RC' + Date.now(), name: name, subs: [] });
    } else {
        var parent = null;
        for (var j = 0; j < list.length; j++) if (String(list[j].name) === String(parentSub.cat)) parent = list[j];
        /* ITEM 8 (spec, 2026-09-14) — "অ্যাডমিন যেই ক্যাটাগরি গুলো আপলোড করে রাখছে ...
           সেগুলো অটোমেটিক্যালি রিসেলার প্যানেলের সব ক্যাটেগরিতে আপলোড করা থাকবে।
           এর পরও রিসেলারের যদি কোনো ক্যাটাগরি দরকার পড়ে, সে ওইখান থেকে অ্যাড করে
           নিতে পারবে।"
           So a reseller MAY hang their own subcategory off an ADMIN main
           category. The parent is materialised in the reseller's OWN tree as a
           `shared: true` node that carries ONLY their extra children — the parent
           itself stays the admin's, which is why the UI shows no delete button
           for it and shopMainCategories() still prefers the global entry. */
        if (!parent && adminCategoryExists(parentSub.cat)) {
            parent = { id: 'RC' + Date.now(), name: String(parentSub.cat), subs: [], shared: true };
            list.push(parent);
        }
        if (!parent) return { ok: false, message: 'Parent category পাওয়া যায়নি।' };
        if (!parent.subs) parent.subs = [];
        if (!parentSub.sub) {
            for (var k = 0; k < parent.subs.length; k++) if (String(catEntryName(parent.subs[k])).toLowerCase() === name.toLowerCase()) return { ok: false, message: 'এই subcategory আগেই আছে।' };
            if (adminSubCategoryExists(parentSub.cat, name)) return { ok: false, message: 'এই subcategory Admin-এর তালিকায় আগেই আছে।' };
            parent.subs.push({ name: name, subSubs: [] });
        } else {
            var sub = null;
            for (var m = 0; m < parent.subs.length; m++) if (String(catEntryName(parent.subs[m])) === String(parentSub.sub)) sub = parent.subs[m];
            /* same rule one level down: a sub-sub may be attached to an ADMIN
               subcategory, which is materialised here as a shared node too. */
            if (!sub && adminSubCategoryExists(parentSub.cat, parentSub.sub)) {
                sub = { name: String(parentSub.sub), subSubs: [], shared: true };
                parent.subs.push(sub);
            }
            if (!sub) return { ok: false, message: 'Parent subcategory পাওয়া যায়নি।' };
            if (!sub.subSubs) sub.subSubs = [];
            if (sub.subSubs.indexOf(name) !== -1) return { ok: false, message: 'এই sub-subcategory আগেই আছে।' };
            sub.subSubs.push(name);
        }
    }
    saveOwnCategories(rid, list);
    return { ok: true };
}
/* Rename a category the RESELLER OWNS (2026-09-18, this request).
   Admin categories are deliberately out of reach: their global entry is shared by
   every shop, so a reseller may only HIDE one (Shop Settings → Shop Categories
   ON/OFF) — never rename it. A `shared` node is an admin entry materialised in the
   reseller's own tree purely to carry their extra children, so it is refused too.
   The duplicate rules mirror ownCategoryAdd() exactly, so a rename can never
   create the invisible duplicate that add() refuses. */
function ownCategoryRename(rid, path, newName) {
    try {
        newName = String(newName || '').trim();
        if (!newName) return { ok: false, message: 'নতুন নাম দিন।' };
        path = path || {};
        var list = getOwnCategoriesRaw(rid);
        var i, j, k;

        /* ---- a MAIN category ---- */
        if (!path.sub && !path.subSub) {
            for (i = 0; i < list.length; i++) {
                if (String(list[i].name) !== String(path.cat)) continue;
                if (list[i].shared) return { ok: false, message: 'এটি Admin-এর category — নাম বদলানো যাবে না, শুধু লুকানো যায়।' };
                for (j = 0; j < list.length; j++) {
                    if (j !== i && String(list[j].name).toLowerCase() === newName.toLowerCase()) {
                        return { ok: false, message: 'এই নামে আপনার আরেকটি category আছে।' };
                    }
                }
                if (adminCategoryExists(newName)) return { ok: false, message: 'Admin-এর তালিকায় এই নামে একটি category আগেই আছে।' };
                list[i].name = newName;
                if (saveOwnCategories(rid, list) === false) return { ok: false, message: 'সেভ করা যায়নি — storage পূর্ণ।' };
                return { ok: true };
            }
            return { ok: false, message: 'Category পাওয়া যায়নি।' };
        }

        /* ---- a SUBCATEGORY or a SUB-SUBCATEGORY ---- */
        var parent = null;
        for (i = 0; i < list.length; i++) if (String(list[i].name) === String(path.cat)) parent = list[i];
        if (!parent) return { ok: false, message: 'Parent category পাওয়া যায়নি।' };
        var subs = parent.subs || [];
        for (j = 0; j < subs.length; j++) {
            if (String(catEntryName(subs[j])) !== String(path.sub)) continue;

            if (!path.subSub) {                                   /* the SUBCATEGORY itself */
                if (subs[j].shared) return { ok: false, message: 'এটি Admin-এর subcategory — নাম বদলানো যাবে না, শুধু লুকানো যায়।' };
                for (k = 0; k < subs.length; k++) {
                    if (k !== j && String(catEntryName(subs[k])).toLowerCase() === newName.toLowerCase()) {
                        return { ok: false, message: 'এই নামে আপনার আরেকটি subcategory আছে।' };
                    }
                }
                if (adminSubCategoryExists(path.cat, newName)) return { ok: false, message: 'Admin-এর তালিকায় এই নামে একটি subcategory আগেই আছে।' };
                subs[j].name = newName;
                if (saveOwnCategories(rid, list) === false) return { ok: false, message: 'সেভ করা যায়নি — storage পূর্ণ।' };
                return { ok: true };
            }

            /* the SUB-SUBCATEGORY inside it */
            var arr = subs[j].subSubs || [];
            for (k = 0; k < arr.length; k++) {
                if (String(arr[k]) !== String(path.subSub)) continue;
                for (var m = 0; m < arr.length; m++) {
                    if (m !== k && String(arr[m]).toLowerCase() === newName.toLowerCase()) {
                        return { ok: false, message: 'এই নামে আপনার আরেকটি sub-subcategory আছে।' };
                    }
                }
                arr[k] = newName;
                if (saveOwnCategories(rid, list) === false) return { ok: false, message: 'সেভ করা যায়নি — storage পূর্ণ।' };
                return { ok: true };
            }
            return { ok: false, message: 'Sub-subcategory পাওয়া যায়নি।' };
        }
        return { ok: false, message: 'Subcategory পাওয়া যায়নি।' };
    } catch (e) { return { ok: false, message: 'নাম বদলানো যায়নি।' }; }
}

/* Deactivate / reactivate a category the reseller OWNS (2026-09-18, this request).
   DEACTIVATE IS A HIDE, NEVER A DELETE: the node stays in the reseller's own tree
   and every product that points at it keeps working, so switching it back on
   restores everything exactly as it was. Hidden nodes simply drop out of the
   readers the shop and the product picker use.

   Shape: a main/sub carries `hidden: true` on the node itself. A SUB-SUB is stored
   as a plain string, so its state lives in a parallel `subSubsHidden` list on the
   parent sub — the node itself is never rewritten into a different shape. */
function ownCategorySetHidden(rid, path, hidden) {
    try {
        path = path || {};
        hidden = !!hidden;
        var list = getOwnCategoriesRaw(rid);
        var i, j;
        for (i = 0; i < list.length; i++) {
            if (!list[i] || String(list[i].name) !== String(path.cat)) continue;

            if (!path.sub) {                                   /* the MAIN itself */
                if (list[i].shared) return { ok: false, message: 'এটি Admin-এর category — এখান থেকে বন্ধ করা যায় না।' };
                list[i].hidden = hidden;
                if (saveOwnCategories(rid, list) === false) return { ok: false, message: 'সেভ করা যায়নি — storage পূর্ণ।' };
                return { ok: true, hidden: hidden };
            }

            var subs = asArray(list[i].subs);
            for (j = 0; j < subs.length; j++) {
                if (!subs[j] || String(catEntryName(subs[j])) !== String(path.sub)) continue;

                if (!path.subSub) {                            /* the SUBCATEGORY */
                    if (subs[j].shared) return { ok: false, message: 'এটি Admin-এর subcategory — এখান থেকে বন্ধ করা যায় না।' };
                    subs[j].hidden = hidden;
                    if (saveOwnCategories(rid, list) === false) return { ok: false, message: 'সেভ করা যায়নি — storage পূর্ণ।' };
                    return { ok: true, hidden: hidden };
                }

                /* the SUB-SUBCATEGORY */
                var arr = asArray(subs[j].subSubs);
                if (arr.map(String).indexOf(String(path.subSub)) === -1) {
                    return { ok: false, message: 'Sub-subcategory পাওয়া যায়নি।' };
                }
                var hid = [];
                var old = asArray(subs[j].subSubsHidden);
                for (var k = 0; k < old.length; k++) {
                    if (String(old[k]) !== String(path.subSub)) hid.push(String(old[k]));
                }
                if (hidden) hid.push(String(path.subSub));
                subs[j].subSubsHidden = hid;
                if (saveOwnCategories(rid, list) === false) return { ok: false, message: 'সেভ করা যায়নি — storage পূর্ণ।' };
                return { ok: true, hidden: hidden };
            }
            return { ok: false, message: 'Subcategory পাওয়া যায়নি।' };
        }
        return { ok: false, message: 'Category পাওয়া যায়নি।' };
    } catch (e) { return { ok: false, message: 'পরিবর্তন করা যায়নি।' }; }
}
/* Is this OWN node currently deactivated? Used by the page to paint the state and
   by the readers to skip it. */
function ownCategoryIsHidden(rid, path) {
    try {
        path = path || {};
        var list = getOwnCategoriesRaw(rid), i, j;
        for (i = 0; i < list.length; i++) {
            if (!list[i] || String(list[i].name) !== String(path.cat)) continue;
            if (!path.sub) return list[i].hidden === true;
            var subs = asArray(list[i].subs);
            for (j = 0; j < subs.length; j++) {
                if (!subs[j] || String(catEntryName(subs[j])) !== String(path.sub)) continue;
                if (!path.subSub) return subs[j].hidden === true;
                return asArray(subs[j].subSubsHidden).map(String).indexOf(String(path.subSub)) !== -1;
            }
        }
        return false;
    } catch (e) { return false; }
}

/* Is `name` a MAIN category of the ADMIN's tree? Read-only lookup: it lets a
   reseller attach their own children to an admin category without ever being
   able to edit or delete the admin's own entry. */
function adminCategoryExists(name) {
    var g = asArray(getData(DB_KEYS.CATEGORIES));
    for (var i = 0; i < g.length; i++) if (g[i] && String(g[i].name) === String(name)) return true;
    return false;
}
/* Is `sub` a subcategory of the admin's `cat`? Reads BOTH shapes the admin tree
   may store (subs[] and the legacy subSubs map). */
function adminSubCategoryExists(cat, sub) {
    var g = asArray(getData(DB_KEYS.CATEGORIES));
    for (var i = 0; i < g.length; i++) {
        if (!g[i] || String(g[i].name) !== String(cat)) continue;
        var subs = asArray(g[i].subs);
        if (!subs.length && g[i].subSubs) { for (var k in g[i].subSubs) { if (Object.prototype.hasOwnProperty.call(g[i].subSubs, k)) subs.push(k); } }
        for (var j = 0; j < subs.length; j++) if (String(catEntryName(subs[j])) === String(sub)) return true;
    }
    return false;
}
/* Names the reseller ACTUALLY owns (a shared node is the admin's, not theirs). */
function ownCategoryNames(rid) {
    var list = getOwnCategories(rid), out = [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].name && !list[i].shared) out.push(String(list[i].name));
    return out;
}
function ownCategoryRemove(rid, path) {
    var list = getOwnCategoriesRaw(rid);
    path = path || {};
    if (!path.sub && !path.subSub) {
        var out = [];
        for (var i = 0; i < list.length; i++) if (String(list[i].name) !== String(path.cat)) out.push(list[i]);
        list = out;
    } else {
        for (var j = 0; j < list.length; j++) {
            if (String(list[j].name) !== String(path.cat)) continue;
            var subs = list[j].subs || [];
            if (!path.subSub) {
                var out2 = [];
                for (var k = 0; k < subs.length; k++) if (String(subs[k].name) !== String(path.sub)) out2.push(subs[k]);
                list[j].subs = out2;
            } else {
                for (var m = 0; m < subs.length; m++) {
                    if (String(subs[m].name) !== String(path.sub)) continue;
                    subs[m].subSubs = (subs[m].subSubs || []).filter(function (x) { return String(x) !== String(path.subSub); });
                }
            }
            break;
        }
    }
    saveOwnCategories(rid, list);
    return { ok: true };
}
/* PART 40, 41, 42 — merged main-category list for one shop only. */

/* ==========================================================================
   BANGLADESH DISTRICTS + THANAS / UPAZILAS   (2026-09-17, this request)
   --------------------------------------------------------------------------
   All 64 districts, each with its own upazila/thana list. The address form
   shows every district; choosing one fills the Thana dropdown with ONLY that
   district's thanas. Shared by the My Shop checkout and the reseller's
   Add New Order, so the two always agree.
   ========================================================================== */
var BD_DISTRICTS = {
    "Dhaka": ["Adabor", "Airport", "Badda", "Banani", "Bangshal", "Bhashantek", "Cantonment", "Chalkbazar", "Dakshinkhan", "Darus-Salam", "Demra", "Dhanmondi", "Gandaria", "Gulshan", "Hazaribagh", "Jatrabari", "Kadamtoli", "Kafrul", "Kalabagan", "Kamrangirchar", "Khilgaon", "Khilkhet", "Kotwali", "Lalbagh", "Mirpur Model", "Mohammadpur", "Motijheel", "Mugda", "New Market", "Pallabi", "Paltan Model", "Ramna Model", "Rampura", "Rupnagar", "Sabujbag", "Shah Ali", "Shahbag", "Shahjahanpur", "Sher-e-Bangla Nagar", "Shyampur", "Sutrapur", "Tejgaon", "Tejgaon Industrial Area", "Turag", "Uttara", "Uttarkhan", "Uttara West", "Vatara", "Wari"],
    "Dhaka Sub-Urban": ["Dhamrai", "Dohar", "Keraniganj", "Nawabganj", "Savar"],
    "Gazipur": ["Gazipur Sadar", "Kaliakair", "Kaliganj", "Kapasia", "Sreepur", "Tongi"],
    "Kishoreganj": ["Austagram", "Bajitpur", "Bhairab", "Hossainpur", "Itna", "Karimganj", "Katiadi", "Kishoreganj Sadar", "Kuliarchar", "Mithamain", "Nikli", "Pakundia", "Tarail", "Mithamoin"],
    "Manikganj": ["Daulatpur", "Ghior", "Harirampur", "Manikganj Sadar", "Saturia", "Shivalaya", "Singair", "Shibaloy"],
    "Munshiganj": ["Gazaria", "Lohajang", "Munshiganj Sadar", "Sirajdikhan", "Sreenagar", "Tongibari", "Louhajong"],
    "Narayanganj": ["Araihazar", "Bandar", "Narayanganj Sadar", "Rupganj", "Sonargaon", "Siddhirganj", "Fatullah"],
    "Narsingdi": ["Belabo", "Monohardi", "Narsingdi Sadar", "Palash", "Raipura", "Shibpur"],
    "Tangail": ["Basail", "Bhuapur", "Delduar", "Dhanbari", "Ghatail", "Gopalpur", "Kalihati", "Madhupur", "Mirzapur", "Nagarpur", "Sakhipur", "Tangail Sadar"],
    "Faridpur": ["Alfadanga", "Bhanga", "Boalmari", "Charbhadrasan", "Faridpur Sadar", "Madhukhali", "Nagarkanda", "Sadarpur", "Saltha"],
    "Gopalganj": ["Gopalganj Sadar", "Kashiani", "Kotalipara", "Muksudpur", "Tungipara"],
    "Madaripur": ["Kalkini", "Madaripur Sadar", "Rajoir", "Shibchar", "Dasar"],
    "Rajbari": ["Baliakandi", "Goalandaghat", "Kalukhali", "Pangsha", "Rajbari Sadar", "Goalanda"],
    "Shariatpur": ["Bhedarganj", "Damudya", "Gosairhat", "Naria", "Shariatpur Sadar", "Zanjira", "Zajira"],
    "Chattogram": ["Anwara", "Banshkhali", "Boalkhali", "Chandanaish", "Fatikchhari", "Hathazari", "Lohagara", "Mirsharai", "Patiya", "Rangunia", "Raozan", "Sandwip", "Satkania", "Sitakunda", "Chattogram Metro (Kotwali)", "Chattogram Metro (Pahartali)", "Chattogram Metro (Double Mooring)", "Chattogram Metro (Panchlaish)", "Karnaphuli"],
    "Cox's Bazar": ["Chakaria", "Cox's Bazar Sadar", "Kutubdia", "Maheshkhali", "Ramu", "Teknaf", "Ukhia", "Pekua", "Eidgaon"],
    "Cumilla": ["Barura", "Brahmanpara", "Burichang", "Chandina", "Chauddagram", "Cumilla Sadar", "Cumilla Sadar Dakshin", "Daudkandi", "Debidwar", "Homna", "Laksam", "Meghna", "Monohorgonj", "Muradnagar", "Nangalkot", "Titas", "Lalmai", "Monohargonj", "Sadar South"],
    "Brahmanbaria": ["Akhaura", "Ashuganj", "Bancharampur", "Bijoynagar", "Brahmanbaria Sadar", "Kasba", "Nabinagar", "Nasirnagar", "Sarail"],
    "Chandpur": ["Chandpur Sadar", "Faridganj", "Haimchar", "Haziganj", "Kachua", "Matlab Dakshin", "Matlab Uttar", "Shahrasti", "Hajiganj", "Matlab North", "Matlab South"],
    "Feni": ["Chhagalnaiya", "Daganbhuiyan", "Feni Sadar", "Fulgazi", "Parshuram", "Sonagazi"],
    "Lakshmipur": ["Kamalnagar", "Lakshmipur Sadar", "Raipur", "Ramganj", "Ramgati"],
    "Noakhali": ["Begumganj", "Chatkhil", "Companiganj", "Hatiya", "Kabirhat", "Senbagh", "Sonaimuri", "Subarnachar", "Noakhali Sadar", "Companyganj"],
    "Rangamati": ["Bagaichhari", "Barkal", "Juraichhari", "Kaptai", "Kawkhali", "Langadu", "Naniarchar", "Rajasthali", "Rangamati Sadar", "Belaichhari", "Baghaichhari"],
    "Bandarban": ["Alikadam", "Bandarban Sadar", "Lama", "Naikhongchhari", "Rowangchhari", "Ruma", "Thanchi"],
    "Khagrachhari": ["Dighinala", "Khagrachhari Sadar", "Lakshmichhari", "Mahalchhari", "Manikchhari", "Matiranga", "Panchhari", "Ramgarh", "Guimara"],
    "Sylhet": ["Balaganj", "Beanibazar", "Bishwanath", "Companiganj", "Fenchuganj", "Golapganj", "Gowainghat", "Jaintiapur", "Kanaighat", "Osmani Nagar", "Sylhet Sadar", "Zakiganj", "Dakshin Surma", "Osmaninagar"],
    "Moulvibazar": ["Barlekha", "Juri", "Kamalganj", "Kulaura", "Moulvibazar Sadar", "Rajnagar", "Sreemangal"],
    "Habiganj": ["Ajmiriganj", "Bahubal", "Baniyachong", "Chunarughat", "Habiganj Sadar", "Lakhai", "Madhabpur", "Nabiganj", "Shayestaganj", "Baniachong"],
    "Sunamganj": ["Bishwamvarpur", "Chhatak", "Derai", "Dharampasha", "Dowarabazar", "Jagannathpur", "Jamalganj", "Sullah", "Sunamganj Sadar", "Tahirpur", "Shantiganj", "Madhyanagar", "Bishwambharpur", "Shalla"],
    "Rajshahi": ["Bagha", "Bagmara", "Charghat", "Durgapur", "Godagari", "Mohanpur", "Paba", "Puthia", "Rajshahi Metro (Boalia)", "Rajshahi Metro (Motihar)", "Rajshahi Metro (Rajpara)", "Tanore"],
    "Bogura": ["Adamdighi", "Bogura Sadar", "Dhunat", "Dhupchanchia", "Gabtali", "Kahaloo", "Nandigram", "Sariakandi", "Shajahanpur", "Sherpur", "Shibganj", "Sonatola", "Dupchanchia", "Kahalu", "Sonatala"],
    "Joypurhat": ["Akkelpur", "Joypurhat Sadar", "Kalai", "Khetlal", "Panchbibi"],
    "Naogaon": ["Atrai", "Badalgachhi", "Dhamoirhat", "Manda", "Mahadevpur", "Naogaon Sadar", "Niamatpur", "Patnitala", "Porsha", "Raninagar", "Sapahar"],
    "Natore": ["Bagatipara", "Baraigram", "Gurudaspur", "Lalpur", "Natore Sadar", "Singra", "Naldanga"],
    "Chapainawabganj": ["Bholahat", "Chapainawabganj Sadar", "Gomastapur", "Nachole", "Shibganj", "Nawabganj Sadar"],
    "Pabna": ["Atgharia", "Bera", "Bhangura", "Chatmohar", "Faridpur", "Ishwardi", "Pabna Sadar", "Santhia", "Sujanagar"],
    "Sirajganj": ["Belkuchi", "Chauhali", "Kamarkhanda", "Kazipur", "Raiganj", "Shahjadpur", "Sirajganj Sadar", "Tarash", "Ullapara", "Kamarkhand"],
    "Khulna": ["Batiaghata", "Dacope", "Dumuria", "Dighalia", "Koyra", "Paikgachha", "Phultala", "Rupsha", "Terokhada", "Khulna Metro (Khalishpur)", "Khulna Metro (Sonadanga)"],
    "Bagerhat": ["Bagerhat Sadar", "Chitalmari", "Fakirhat", "Kachua", "Mollahat", "Mongla", "Morrelganj", "Rampal", "Sarankhola", "Sharankhola"],
    "Chuadanga": ["Alamdanga", "Chuadanga Sadar", "Damurhuda", "Jibannagar"],
    "Jashore": ["Abhaynagar", "Bagherpara", "Chaugachha", "Jhikargachha", "Keshabpur", "Jashore Sadar", "Manirampur", "Sharsha"],
    "Jhenaidah": ["Harinakunda", "Jhenaidah Sadar", "Kaliganj", "Kotchandpur", "Maheshpur", "Shailkupa", "Harinakundu"],
    "Kushtia": ["Bheramara", "Daulatpur", "Khoksa", "Kumarkhali", "Kushtia Sadar", "Mirpur"],
    "Magura": ["Magura Sadar", "Mohammadpur", "Shalikha", "Sreepur"],
    "Meherpur": ["Gangni", "Meherpur Sadar", "Mujibnagar"],
    "Narail": ["Kalia", "Lohagara", "Narail Sadar"],
    "Satkhira": ["Assasuni", "Debhata", "Kalaroa", "Kaliganj", "Satkhira Sadar", "Shyamnagar", "Tala"],
    "Barishal": ["Agailjhara", "Babuganj", "Bakerganj", "Banaripara", "Barishal Sadar", "Gaurnadi", "Hizla", "Mehendiganj", "Muladi", "Wazirpur"],
    "Barguna": ["Amtali", "Bamna", "Barguna Sadar", "Betagi", "Patharghata", "Taltali"],
    "Bhola": ["Bhola Sadar", "Borhanuddin", "Char Fasson", "Daulatkhan", "Lalmohan", "Manpura", "Tazumuddin"],
    "Jhalokati": ["Jhalokati Sadar", "Kathalia", "Nalchity", "Rajapur", "Kanthalia"],
    "Patuakhali": ["Bauphal", "Dashmina", "Dumki", "Galachipa", "Kalapara", "Mirzaganj", "Patuakhali Sadar", "Rangabali"],
    "Pirojpur": ["Bhandaria", "Kawkhali", "Mathbaria", "Nazirpur", "Nesarabad", "Pirojpur Sadar", "Zianagar", "Indurkani"],
    "Rangpur": ["Badarganj", "Gangachara", "Kaunia", "Mithapukur", "Pirgachha", "Pirganj", "Rangpur Sadar", "Taraganj"],
    "Dinajpur": ["Birampur", "Birganj", "Biral", "Bochaganj", "Chirirbandar", "Dinajpur Sadar", "Fulbari", "Ghoraghat", "Hakimpur", "Kaharole", "Khansama", "Nawabganj", "Parbatipur", "Birol"],
    "Gaibandha": ["Fulchhari", "Gaibandha Sadar", "Gobindaganj", "Palashbari", "Sadullapur", "Saghata", "Sundarganj", "Phulchhari"],
    "Kurigram": ["Bhurungamari", "Char Rajibpur", "Chilmari", "Kurigram Sadar", "Nageshwari", "Phulbari", "Rajarhat", "Raomari", "Ulipur", "Rajibpur", "Roumari"],
    "Lalmonirhat": ["Aditmari", "Hatibandha", "Kaliganj", "Lalmonirhat Sadar", "Patgram"],
    "Nilphamari": ["Dimla", "Domar", "Jaldhaka", "Kishoreganj", "Nilphamari Sadar", "Saidpur"],
    "Panchagarh": ["Atwari", "Boda", "Debiganj", "Panchagarh Sadar", "Tetulia"],
    "Thakurgaon": ["Baliadangi", "Haripur", "Pirganj", "Ranisankail", "Thakurgaon Sadar", "Ranishankail"],
    "Mymensingh": ["Bhaluka", "Dhobaura", "Fulbaria", "Gaffargaon", "Gauripur", "Haluaghat", "Ishwarganj", "Muktagachha", "Mymensingh Sadar", "Nandail", "Phulpur", "Tarakanda", "Trishal"],
    "Jamalpur": ["Baksiganj", "Dewanganj", "Islampur", "Jamalpur Sadar", "Madarganj", "Melandaha", "Sarishabari", "Bakshiganj"],
    "Netrokona": ["Atpara", "Barhatta", "Durgapur", "Khaliajuri", "Kalmakanda", "Madan", "Mohanganj", "Netrokona Sadar", "Purbadhala", "Kendua"],
    "Sherpur": ["Jhenaigati", "Nakla", "Nalitabari", "Sherpur Sadar", "Sreebardi"]
};
var BD_DISTRICT_NAMES = ["Dhaka", "Dhaka Sub-Urban", "Gazipur", "Kishoreganj", "Manikganj", "Munshiganj", "Narayanganj", "Narsingdi", "Tangail", "Faridpur", "Gopalganj", "Madaripur", "Rajbari", "Shariatpur", "Chattogram", "Cox's Bazar", "Cumilla", "Brahmanbaria", "Chandpur", "Feni", "Lakshmipur", "Noakhali", "Rangamati", "Bandarban", "Khagrachhari", "Sylhet", "Moulvibazar", "Habiganj", "Sunamganj", "Rajshahi", "Bogura", "Joypurhat", "Naogaon", "Natore", "Chapainawabganj", "Pabna", "Sirajganj", "Khulna", "Bagerhat", "Chuadanga", "Jashore", "Jhenaidah", "Kushtia", "Magura", "Meherpur", "Narail", "Satkhira", "Barishal", "Barguna", "Bhola", "Jhalokati", "Patuakhali", "Pirojpur", "Rangpur", "Dinajpur", "Gaibandha", "Kurigram", "Lalmonirhat", "Nilphamari", "Panchagarh", "Thakurgaon", "Mymensingh", "Jamalpur", "Netrokona", "Sherpur"];
/* Thanas of one district; [] for an unknown district. */
function bdThanas(district) {
    try { return BD_DISTRICTS[String(district || '').trim()] || []; } catch (e) { return []; }
}

/* ==========================================================================
   DELIVERY ZONE, DECIDED BY THE DISTRICT (2026-09-18 — this request)
   --------------------------------------------------------------------------
   The customer never picks the zone; the DISTRICT decides it, automatically:
     · "Dhaka"            -> inside   (admin Settings -> Inside charge)
     · "Dhaka Sub-Urban"  -> suburban (a FIXED ৳100, nothing to select)
     · any other district -> outside  (admin Settings -> Outside charge)
   Nothing chosen yet      -> inside  (the confirmed default)
   ONE resolver, used by BOTH the My Shop checkout and the reseller's Add New
   Order, so the two pages can never disagree about what a district costs.
   ========================================================================== */
var BD_SUBURBAN_CHARGE = 100;
function bdDeliveryZone(district) {
    var d = String(district === undefined || district === null ? '' : district).trim();
    if (!d) return 'inside';                       /* nothing chosen yet */
    if (d === 'Dhaka') return 'inside';
    if (d === 'Dhaka Sub-Urban') return 'suburban';
    return 'outside';
}
/* The customer-facing delivery charge for a district. The suburban rate is fixed
   in code on purpose (the user's decision) — there is no Settings field for it. */
function bdDeliveryRate(district, insideRate, outsideRate) {
    var z = bdDeliveryZone(district);
    if (z === 'suburban') return BD_SUBURBAN_CHARGE;
    if (z === 'outside') return Number(outsideRate) || 0;
    return Number(insideRate) || 0;
}
/* The order's delivery tier. Orders written BEFORE the suburban tier existed
   carry only 'inside'/'outside'; anything unrecognised stays 'inside', which is
   exactly what orderInsideDhaka() has always assumed. */
function orderDeliveryTier(o) {
    var m = String((o && o.shippingMethod) || '').toLowerCase().trim();
    if (m === 'suburban') return 'suburban';
    if (m === 'outside') return 'outside';
    return 'inside';
}
/* Human label for an order's delivery tier — one place, so the print sheet, the
   admin list and the admin My Shop list can never word it differently. */
function orderShippingLabel(o) {
    var t = orderDeliveryTier(o);
    if (t === 'suburban') return 'Dhaka Sub-Urban';
    return t === 'outside' ? 'Outside Dhaka' : 'Inside Dhaka';
}

/* 2026-09-17 — one de-dupe key for category names.
   The shop header was showing "MEN'S FASHION" twice because the same category is
   stored under three spellings — 'Men Fashion' (the built-in tree), "Men's Fashion"
   (a custom global) and 'mens fashion' (a reseller's own copy). A plain
   toLowerCase() treats all three as different, so every one of them rendered.
   This folds them together: apostrophes dropped, non-alphanumerics to spaces, and
   men/mens normalised. Returns '' for an empty name, which callers skip. */
function catDedupeKey(name) {
    var s = String(name == null ? '' : name).toLowerCase();
    s = s.replace(/[\u2018\u2019'`]/g, '');       /* men's -> mens */
    s = s.replace(/[^a-z0-9]+/g, ' ').trim();       /* punctuation/space -> one space */
    s = s.replace(/\bmens?\b/g, 'men');            /* mens -> men */
    s = s.replace(/\bwomens?\b/g, 'women');        /* womens -> women */
    return s;
}

/* 2026-09-17 — the order the My Shop header shows its main categories in, and the
   label used for each. The user listed it explicitly:
     HOME · MEN'S FASHION · WOMEN'S FASHION · GADGET & ELECTRONICS ·
     SPECIAL PRODUCT · KIDS · OFFER
   Matching uses catDedupeKey(), so 'Men Fashion' and "Men's Fashion" both land on
   the MEN'S FASHION slot. Anything not listed keeps its stored order AFTER these,
   so a reseller's own extra categories are never hidden. */
var SHOP_NAV_ORDER = [
    { key: 'men fashion',        label: "MEN'S FASHION" },
    { key: 'women fashion',      label: "WOMEN'S FASHION" },
    { key: 'gadget electronics', label: 'GADGET & ELECTRONICS' },
    { key: 'special product',    label: 'SPECIAL PRODUCT' },
    { key: 'kids',               label: 'KIDS' }
];
/* Put a category list into the order above. Unknown names keep their relative order
   at the end. Returns a NEW array; the input is not modified. */
function orderShopNav(list) {
    var arr = list || [];
    var out = [], used = [];
    for (var i = 0; i < SHOP_NAV_ORDER.length; i++) {
        var want = SHOP_NAV_ORDER[i];
        for (var j = 0; j < arr.length; j++) {
            if (used[j]) continue;
            if (catDedupeKey(arr[j].name) === want.key) {
                used[j] = 1;
                out.push({ name: arr[j].name, own: arr[j].own, icon: arr[j].icon, image: arr[j].image, label: want.label });
                break;
            }
        }
    }
    for (var k = 0; k < arr.length; k++) {
        if (!used[k]) out.push(arr[k]);
    }
    return out;
}

/* 2026-09-17 — category keys that tolerate a trailing plural.
   The header chip can read "T-Shirts" while the product stored "T-Shirt" (the same
   way "Men's Fashion" and "Men Fashion" are one category). catDedupeKey() already
   folds case, punctuation and men/women; this also folds a plural on words of four
   or more letters, so T-Shirt / T-Shirts and Pant / Pants are the same thing.
   Short words are left alone, and both sides get the same treatment, so a name that
   genuinely ends in s (e.g. "Dress") still matches itself. */
function catKeySoft(name) {
    var k = catDedupeKey(name);
    return k.replace(/\b([a-z]{4,})s\b/g, '$1');
}
function catKeyMatch(a, b) {
    var ka = catDedupeKey(a), kb = catDedupeKey(b);
    if (ka === kb) return true;
    return catKeySoft(a) === catKeySoft(b);
}
/* `includeHidden` (2026-09-18, optional, default false) keeps DEACTIVATED own
   nodes in the result. The shop and the product picker must never see them, but
   the Shop Categories page MUST, or a deactivated category could never be turned
   back on. Existing callers are unaffected — the default is the old behaviour. */
function shopMainCategories(rid, includeHidden) {
    var out = [], seen = {};
    var globals = asArray(getData(DB_KEYS.CATEGORIES));
    for (var i = 0; i < globals.length; i++) {
        var g = globals[i];
        if (!g) continue;
        var nm = String(g.name || '').trim();
        if (!nm || seen[catDedupeKey(nm)]) continue;
        /* #21 — only the active structure is shown in the nav */
        if (g.primary === false) continue;
        if (!isCategoryVisible(rid, 'cats', nm)) continue;      /* existing ON/OFF */
        seen[catDedupeKey(nm)] = 1;
        out.push({ name: nm, own: false, icon: g.icon || 'fa-tag', image: g.image || '' });
    }
    var mine = asArray(getOwnCategories(rid));
    for (var j = 0; j < mine.length; j++) {
        var m = mine[j];
        if (!m || !m.name) continue;
        if (seen[catDedupeKey(m.name)]) continue;
        if (m.hidden === true && !includeHidden) continue;      /* deactivated */
        seen[catDedupeKey(m.name)] = 1;
        out.push({ name: String(m.name), own: true, icon: m.icon || 'fa-folder', image: '', hidden: m.hidden === true });
    }
    return out;
}
/* Subcategories of one main category for this shop (global + own). */
function shopSubCategories(rid, catName, includeHidden) {
    var out = [], seen = {};
    var globals = asArray(getData(DB_KEYS.CATEGORIES));
    for (var i = 0; i < globals.length; i++) {
        var g = globals[i];
        if (!g || String(g.name) !== String(catName)) continue;
        var subs = [];
        if (g.subs && g.subs.length) subs = asArray(g.subs);
        else if (g.subSubs) { for (var k in g.subSubs) { if (Object.prototype.hasOwnProperty.call(g.subSubs, k)) subs.push(k); } }
        for (var j = 0; j < subs.length; j++) {
            /* a sub may be a plain string OR the {name, subSubs} object the
               admin editor writes — read the name out of either shape. */
            var nm = catEntryName(subs[j]);
            if (!nm || seen[nm.toLowerCase()]) continue;
            if (!isCategoryVisible(rid, 'subs', shopCatKey(catName, nm))) continue;
            seen[nm.toLowerCase()] = 1;
            out.push({ name: nm, own: false });
        }
    }
    var mine = asArray(getOwnCategories(rid));
    for (var m = 0; m < mine.length; m++) {
        if (!mine[m] || String(mine[m].name) !== String(catName)) continue;
        var ms = asArray(mine[m].subs);
        for (var n = 0; n < ms.length; n++) {
            var mn = String(ms[n].name || '').trim();
            if (!mn || seen[mn.toLowerCase()]) continue;
            if (ms[n].hidden === true && !includeHidden) continue;   /* deactivated */
            seen[mn.toLowerCase()] = 1;
            out.push({ name: mn, own: true, hidden: ms[n].hidden === true });
        }
    }
    return out;
}
function shopSubSubCategories(rid, catName, subName, includeHidden) {
    var out = [], seen = {};
    var globals = asArray(getData(DB_KEYS.CATEGORIES));
    for (var i = 0; i < globals.length; i++) {
        var g = globals[i];
        if (!g || String(g.name) !== String(catName)) continue;
        var list = [];
        /* sub-sub list lives either in the legacy map g.subSubs[sub] or inside
           the matching subs[].subSubs entry — support BOTH. */
        if (g.subSubs && g.subSubs[subName]) list = asArray(g.subSubs[subName]).slice();
        var gsubs = asArray(g.subs);
        for (var s = 0; s < gsubs.length; s++) {
            var gs = gsubs[s];
            if (!gs || String(gs.name || '') !== String(subName)) continue;
            var inner = asArray(gs.subSubs);
            for (var q = 0; q < inner.length; q++) list.push(inner[q]);
        }
        for (var j = 0; j < list.length; j++) {
            var nm = catEntryName(list[j]);
            if (!nm || seen[nm.toLowerCase()]) continue;
            if (!isCategoryVisible(rid, 'subsubs', shopCatKey(catName, subName, nm))) continue;
            seen[nm.toLowerCase()] = 1;
            out.push({ name: nm, own: false });
        }
    }
    var mine = getOwnCategories(rid);
    for (var m = 0; m < mine.length; m++) {
        if (!mine[m] || String(mine[m].name) !== String(catName)) continue;
        var subs = asArray(mine[m].subs);
        for (var n = 0; n < subs.length; n++) {
            if (!subs[n] || String(subs[n].name) !== String(subName)) continue;
            var ss = asArray(subs[n].subSubs);
            var hid = asArray(subs[n].subSubsHidden).map(String);
            for (var p = 0; p < ss.length; p++) {
                var sn = catEntryName(ss[p]);
                if (!sn || seen[sn.toLowerCase()]) continue;
                var isHid = hid.indexOf(String(sn)) !== -1;
                if (isHid && !includeHidden) continue;              /* deactivated */
                seen[sn.toLowerCase()] = 1;
                out.push({ name: sn, own: true, hidden: isHid });
            }
        }
    }
    return out;
}

/* ===========================================================================
   ITEM 20 (spec, 2026-09-14) — My Shop HOMEPAGE SECTIONS
   ---------------------------------------------------------------------------
   The shop homepage lists, for each MAIN category of that shop, in this order:
       1. the main-category products
       2. that category's SUB-category products
       3. that category's SUB-SUB-category products
   ...and after that nothing — the footer follows directly.

   Each product belongs to exactly ONE section: its DEEPEST match. A product
   carrying category + sub + subSub therefore appears in the sub-sub section
   ONLY, never three times; a product with no sub appears in the main section.

   On top of that, the reseller — and the admin, for any shop — can PIN
   products into a section by hand, in their own order. A pinned product MOVES
   there, so it leaves its natural section and "each product once" still holds.
   Pins live in `rh_shop_sections` keyed by reseller id, so one shop's
   arrangement can never reach into another shop's homepage.
   =========================================================================== */
var SHOP_SECTION_SEP = '||';
var SHOP_SECTION_PRODUCTS = 6;          /* cards per homepage section (item 20) */

function shopSectionKey(cat, sub, subsub) {
    var k = String(cat === undefined || cat === null ? '' : cat).trim();
    var s = String(sub === undefined || sub === null ? '' : sub).trim();
    var q = String(subsub === undefined || subsub === null ? '' : subsub).trim();
    if (s) k += SHOP_SECTION_SEP + s;
    if (q) k += SHOP_SECTION_SEP + q;
    return k;
}
function shopSectionParts(key) {
    var p = String(key === undefined || key === null ? '' : key).split(SHOP_SECTION_SEP);
    return { cat: String(p[0] || '').trim(), sub: String(p[1] || '').trim(), subsub: String(p[2] || '').trim() };
}
/* The section a product naturally belongs to — its DEEPEST match. */
function shopProductSectionKey(p) {
    if (!p) return '';
    var cat = String(p.category || '').trim();
    if (!cat) return '';
    var sub = String(p.section || p.subSection || '').trim();
    var ss = String(p.subSub || '').trim();
    if (sub && ss) return shopSectionKey(cat, sub, ss);
    if (sub) return shopSectionKey(cat, sub);
    return shopSectionKey(cat);
}
/* ---- the per-shop pin store ---- */
function getShopSectionPins(rid) {
    var all = getData(DB_KEYS.SHOP_SECTIONS);
    if (!all || typeof all !== 'object' || Object.prototype.toString.call(all) === '[object Array]') return {};
    var mine = all[String(rid)];
    if (!mine || typeof mine !== 'object' || Object.prototype.toString.call(mine) === '[object Array]') return {};
    return mine;
}
function setShopSectionPins(rid, map) {
    var all = getData(DB_KEYS.SHOP_SECTIONS);
    if (!all || typeof all !== 'object' || Object.prototype.toString.call(all) === '[object Array]') all = {};
    all[String(rid)] = (map && typeof map === 'object' && Object.prototype.toString.call(map) !== '[object Array]') ? map : {};
    setData(DB_KEYS.SHOP_SECTIONS, all);
    return all[String(rid)];
}
function shopSectionPinnedIds(rid, key) {
    var ids = asArray(getShopSectionPins(rid)[String(key)]);
    var out = [];
    for (var i = 0; i < ids.length; i++) {
        var v = String(ids[i] === undefined || ids[i] === null ? '' : ids[i]).trim();
        if (v) out.push(v);
    }
    return out;
}
/* Pin `pid` at the END of `key` (a product can only ever be pinned once —
   it is removed from every other section first, so the "each product once"
   rule cannot be broken by hand either). */
function pinProductToShopSection(rid, key, pid) {
    var id = String(pid === undefined || pid === null ? '' : pid).trim();
    if (!id) return getShopSectionPins(rid);
    var map = getShopSectionPins(rid);
    var keys = Object.keys(map), k;
    for (k = 0; k < keys.length; k++) {
        var list = asArray(map[keys[k]]), keep = [];
        for (var i = 0; i < list.length; i++) if (String(list[i]) !== id) keep.push(String(list[i]));
        map[keys[k]] = keep;
    }
    map[String(key)] = asArray(map[String(key)]).concat([id]);
    return setShopSectionPins(rid, map);
}
function unpinProductFromShopSection(rid, key, pid) {
    var id = String(pid === undefined || pid === null ? '' : pid).trim();
    var map = getShopSectionPins(rid);
    var list = asArray(map[String(key)]), keep = [];
    for (var i = 0; i < list.length; i++) if (String(list[i]) !== id) keep.push(String(list[i]));
    map[String(key)] = keep;
    return setShopSectionPins(rid, map);
}
/* dir = -1 up, +1 down. Reordering only ever touches its own section. */
function moveShopSectionPin(rid, key, pid, dir) {
    var id = String(pid === undefined || pid === null ? '' : pid).trim();
    var map = getShopSectionPins(rid);
    var list = asArray(map[String(key)]).map(String);
    var at = -1;
    for (var i = 0; i < list.length; i++) if (list[i] === id) { at = i; break; }
    if (at === -1) return map;
    var to = at + (Number(dir) < 0 ? -1 : 1);
    if (to < 0 || to >= list.length) return map;
    var tmp = list[at]; list[at] = list[to]; list[to] = tmp;
    map[String(key)] = list;
    return setShopSectionPins(rid, map);
}
/* Back to fully automatic for one section (or the whole shop). */
function clearShopSectionPins(rid, key) {
    var map = getShopSectionPins(rid);
    if (key === undefined || key === null || key === '') return setShopSectionPins(rid, {});
    delete map[String(key)];
    return setShopSectionPins(rid, map);
}
function shopSectionHasPins(rid, key) {
    return shopSectionPinnedIds(rid, key).length > 0;
}

/* ---------------------------------------------------------------------------
   shopHomepageSections(rid, opts)
   ---------------------------------------------------------------------------
   The ONE resolver the homepage renders from. Returns the ordered section list:
     [{ key, cat, sub, subsub, title, depth, total, products:[…] }]
   `products` is the FULL list for that section; the page caps the display at
   `perSection` (default SHOP_SECTION_PRODUCTS) and offers "View All".
   Sections with no products are dropped, exactly as before.
   --------------------------------------------------------------------------- */
/* ==========================================================================
   SECTION ORDER  (2026-09-17, this request)
   --------------------------------------------------------------------------
   shopHomepageSections() has always called `catSectionOrder(mains)` if it exists —
   but it never did, so the guard silently did nothing and the homepage order was
   whatever the category tree happened to give. That is why a reseller could not put
   their own menu ABOVE Gadget.
   The order is a plain list of main-category names in rh_shop_settings[rid].order.
   Anything not in the list keeps its tree position AFTER the listed ones, so a newly
   created menu is never lost and an old saved order never hides a category.
   ========================================================================== */
function shopSectionOrder(rid) {
    try {
        var s = getShopSettings(rid);
        var a = (s && s.order) ? s.order : [];
        return Object.prototype.toString.call(a).match(/Array/) ? a : [];
    } catch (e) { return []; }
}
function setShopSectionOrder(rid, list) {
    return patchShopSettings(rid, { order: asArray(list).map(String) });
}
/* Put a list of {name,...} in the saved order. Unlisted entries keep their relative
   position at the end. Returns a NEW array; the input is not modified. */
function catSectionOrder(list, rid) {
    var arr = asArray(list);
    /* take the shop id from the caller when it gives one, else from the page global */
    if (rid === undefined || rid === null || rid === '') {
        try { rid = (typeof RID !== 'undefined' && RID !== null) ? RID : null; } catch (e) { rid = null; }
    }
    var want = (rid === null || rid === undefined || rid === '') ? [] : shopSectionOrder(rid);
    if (!want.length) return arr.slice();
    var out = [], used = [];
    for (var i = 0; i < want.length; i++) {
        for (var j = 0; j < arr.length; j++) {
            if (used[j]) continue;
            if (catDedupeKey(arr[j].name) === catDedupeKey(want[i])) { used[j] = 1; out.push(arr[j]); break; }
        }
    }
    for (var k = 0; k < arr.length; k++) if (!used[k]) out.push(arr[k]);
    return out;
}
/* ==========================================================================
   HOMEPAGE BLOCKS  (2026-09-17, this request)
   --------------------------------------------------------------------------
   A block is ONE row on the shop homepage — "Flash Deals", "Half Sleeve" — with an
   icon, a title, a small subtitle, and up to N product cards. The reseller creates
   and arranges them; each shop's blocks are its own (stored per rid).

   Two kinds, exactly as the user described:
     * CATEGORY block — the reseller picks a category, sub or sub-sub. "View All"
       goes to that category page. If the reseller hand-picks products, those show.
       If they do NOT pick any, the block fills itself from what THIS customer has
       been looking at inside that category (see shopBlockResolve).
     * MIXED block — no category at all, like Flash Deals. The reseller hand-picks
       products from any category. There is NO "View All", because there is no one
       category to link to.

   Stored in rh_shop_settings[rid].blocks so it travels with the shop's settings and
   can never leak into another reseller's homepage.
   ========================================================================== */
/* 2026-09-18 — the blocks that must actually RENDER: the reseller's own list if
   they have one, otherwise the admin's default set (see MY SHOP DEFAULTS above).
   Every writer (shopBlockAdd/Update/Remove/Move) reads through here too, so the
   first time a reseller changes anything the admin's default is copied into their
   own settings and then diverges — the default itself is never modified. */
function shopBlocks(rid) {
    /* the reseller's own list if they have one — even an empty one, so deleting
       the last block leaves an empty homepage instead of resurrecting the
       admin's default; otherwise the admin's default set */
    return shopBlocksHasOwn(rid) ? shopBlocksOwn(rid) : myshopDefaultBlocks();
}
/* The STOREFRONT view of the blocks. The premium gate lives HERE, exactly as it
   does for the banners: a shop whose premium/trial has run out shows the FREE
   look — the platform defaults — and the reseller's own homepage design rests
   until they re-upgrade. Nothing is ever deleted.
   This reproduces the storefront's previous behaviour exactly (before the fix the
   gated reader happened to produce this same answer), so no shop's live look
   changes; only the management UI is now honest about what was saved. */
function shopBlocksStorefront(rid) {
    var open = true;
    try { open = premiumShopOpen(rid); } catch (e) { }
    if (!open) return myshopDefaultBlocks();                 /* the free look */
    return shopBlocksHasOwn(rid) ? shopBlocksOwn(rid) : myshopDefaultBlocks();
}
function shopBlocksSave(rid, list) {
    return patchShopSettings(rid, { blocks: asArray(list) });
}
function shopBlockNewId() { return 'BLK' + Date.now() + Math.floor(Math.random() * 1000); }
/* A new block. `cat` empty => a MIXED block (no View All). */
function shopBlockAdd(rid, data) {
    var d = data || {};
    var b = {
        id: shopBlockNewId(),
        icon: String(d.icon || 'fa-bolt'),
        title: String(d.title || ''),
        subtitle: String(d.subtitle || ''),
        cat: String(d.cat || ''),
        sub: String(d.sub || ''),
        subsub: String(d.subsub || ''),
        products: asArray(d.products).map(String),
        hidden: false
    };
    var list = shopBlocks(rid).slice();
    list.push(b);
    if (shopBlocksSave(rid, list) === false) return null;
    return b.id;
}
function shopBlockUpdate(rid, id, patch) {
    var list = shopBlocks(rid).slice();
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) !== String(id)) continue;
        for (var k in patch) {
            if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
            list[i][k] = patch[k];
        }
        return shopBlocksSave(rid, list) === false ? false : true;
    }
    return false;
}
function shopBlockRemove(rid, id) {
    var list = shopBlocks(rid).slice(), out = [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) !== String(id)) out.push(list[i]);
    if (out.length === list.length) return false;
    return shopBlocksSave(rid, out) === false ? false : true;
}
function shopBlockMove(rid, id, dir) {
    var list = shopBlocks(rid).slice();
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) { idx = i; break; }
    if (idx === -1) return false;
    var to = idx + (dir < 0 ? -1 : 1);
    if (to < 0 || to >= list.length) return false;
    var t = list[idx]; list[idx] = list[to]; list[to] = t;
    return shopBlocksSave(rid, list) === false ? false : true;
}
/* Which products a block should draw.
   `viewed` is the customer's recent category trail (deepest names, newest first) —
   it is only consulted when the reseller has NOT hand-picked any product. */
function shopBlockResolve(rid, block, viewed) {
    var out = [];
    if (!block) return out;
    var all = asArray(shopVisibleProducts(rid));
    var byId = {};
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].id !== undefined) byId[String(all[i].id)] = all[i];

    /* 1 — the reseller's own picks always win */
    var picks = asArray(block.products);
    if (picks.length) {
        for (var p = 0; p < picks.length; p++) {
            var prod = byId[String(picks[p])];
            if (prod) out.push(prod);
        }
        return out;
    }

    /* 2 — no picks: fill from the block's category, narrowed by what the customer
           has been browsing. A sub / sub-sub block is already narrow, so it only
           ever shows its own products. */
    var inCat = [];
    for (var a = 0; a < all.length; a++) {
        var it = all[a];
        if (block.cat && !catKeyMatch(it.category, block.cat)) continue;
        if (block.sub && !catKeyMatch((it.section || it.subSection || ''), block.sub)) continue;
        if (block.subsub && !catKeyMatch(it.subSub, block.subsub)) continue;
        inCat.push(it);
    }
    if (block.subsub || block.sub) return inCat;      /* already exact */

    /* a MAIN-category block: prefer the sub the customer was just looking at */
    var trail = asArray(viewed).map(String);
    for (var t = 0; t < trail.length; t++) {
        var want = trail[t], hit = [];
        for (var m = 0; m < inCat.length; m++) {
            if (catKeyMatch((inCat[m].section || inCat[m].subSection || ''), want)) hit.push(inCat[m]);
        }
        if (hit.length) return hit;
    }
    return inCat;
}
function shopHomepageSections(rid, opts) {
    opts = opts || {};
    var per = Number(opts.perSection) > 0 ? Number(opts.perSection) : SHOP_SECTION_PRODUCTS;
    var all = asArray(shopVisibleProducts(rid));
    var byId = {}, i, j;
    for (i = 0; i < all.length; i++) if (all[i] && all[i].id !== undefined) byId[String(all[i].id)] = all[i];

    /* 1 — natural bucket: the deepest match, so every product lands in ONE place */
    var buckets = {};
    function push(key, prod) { if (!buckets[key]) buckets[key] = []; buckets[key].push(prod); }
    for (i = 0; i < all.length; i++) {
        var k = shopProductSectionKey(all[i]);
        if (k) push(k, all[i]);
    }

    /* 2 — overlay the hand-pinned arrangement */
    var pins = getShopSectionPins(rid);
    var pinKeys = Object.keys(pins);
    var owner = {};                                     /* pid -> section key */
    for (i = 0; i < pinKeys.length; i++) {
        var ids = asArray(pins[pinKeys[i]]);
        for (j = 0; j < ids.length; j++) {
            var id = String(ids[j]);
            if (!owner[id]) owner[id] = pinKeys[i];
        }
    }
    /* a pinned product LEAVES its natural section */
    var bk;
    for (bk in buckets) {
        if (!Object.prototype.hasOwnProperty.call(buckets, bk)) continue;
        var keep = [];
        for (j = 0; j < buckets[bk].length; j++) {
            if (owner[String(buckets[bk][j].id)]) continue;
            keep.push(buckets[bk][j]);
        }
        buckets[bk] = keep;
    }
    /* ...and lands in the pinned one, at the pinned position */
    for (i = 0; i < pinKeys.length; i++) {
        var plist = asArray(pins[pinKeys[i]]), put = [];
        for (j = 0; j < plist.length; j++) {
            var prod = byId[String(plist[j])];
            if (prod) put.push(prod);                   /* ignore a deleted product */
        }
        if (!put.length) continue;
        buckets[pinKeys[i]] = put.concat(buckets[pinKeys[i]] || []);
    }

    /* 3 — walk the shop's own category tree so the ORDER is
           main → sub → sub-sub, per main category */
    var mains = asArray(shopMainCategories(rid));
    /* the homepage owns the intended display order; reuse it when present so the
       nav and the sections can never disagree, but stay self-sufficient. */
    if (typeof catSectionOrder === 'function') { try { mains = catSectionOrder(mains, rid); } catch (e) {} }
    var ordered = [], seenKey = {};
    function addSection(cat, sub, subsub) {
        var key = shopSectionKey(cat, sub, subsub);
        if (!key || seenKey[key]) return;
        seenKey[key] = 1;
        /* the reseller removed this section from their homepage (2026-09-15) —
           a display choice only; the products are untouched */
        if (shopSectionHidden(rid, key)) return;
        var list = (buckets[key] || []).slice();
        /* 2026-09-15 — the HOMEPAGE only wants sections that actually have
           products (an empty block would be pointless). The SETTINGS page asks
           for the empty ones too via opts.includeEmpty: without that, a menu the
           reseller had just created would vanish from the list, look like the
           add had failed, and could not be given a sub-menu from there. */
        if (!list.length && !opts.includeEmpty) return;
        list.sort(function (a, b) { return (Number(b.discount) || 0) - (Number(a.discount) || 0); });
        ordered.push({
            key: key, cat: cat, sub: sub, subsub: subsub, depth: (subsub ? 3 : (sub ? 2 : 1)),
            total: list.length, products: list
        });
    }
    for (i = 0; i < mains.length; i++) {
        var cname = String(mains[i].name || '').trim();
        if (!cname) continue;
        addSection(cname, '', '');                      /* 1. the main category   */
        var subs = asArray(shopSubCategories(rid, cname));
        for (j = 0; j < subs.length; j++) {
            var sname = String(subs[j].name || '').trim();
            if (!sname) continue;
            addSection(cname, sname, '');               /* 2. its sub-categories  */
            var sss = asArray(shopSubSubCategories(rid, cname, sname));
            for (var q = 0; q < sss.length; q++) {
                var qname = String(sss[q].name || '').trim();
                if (qname) addSection(cname, sname, qname);   /* 3. and their sub-subs */
            }
        }
    }
    /* any pinned section the tree walk did not reach (e.g. a category that is
       no longer in the nav) is still shown, appended — never silently dropped */
    for (bk in buckets) {
        if (!Object.prototype.hasOwnProperty.call(buckets, bk)) continue;
        if (seenKey[bk] || !buckets[bk].length) continue;
        var parts = shopSectionParts(bk);
        if (!parts.cat) continue;
        addSection(parts.cat, parts.sub, parts.subsub);
    }
    return ordered;
}
/* Human title for a section: "Men's Fashion" → "Men's Fashion › Panjabi" */
function shopSectionTitle(sec) {
    if (!sec) return '';
    /* 2026-09-15 — show ONLY the deepest category name.
       A section for "Gadget & Electronics > Speaker > Bluetooth Speaker" must
       read just "Bluetooth Speaker". Printing the whole chain turned every
       heading into a long line and buried the one name that matters. */
    return String(sec.subsub || sec.sub || sec.cat || '');
}
/* How many the page should actually draw before "View All". */
function shopSectionShown(sec, perSection) {
    var per = Number(perSection) > 0 ? Number(perSection) : SHOP_SECTION_PRODUCTS;
    return asArray(sec && sec.products).slice(0, per);
}

/* ---------- PART 14 - 19: tickets ---------- */
var TICKET_STATUS = { OPEN: 'open', WAITING_ADMIN: 'waiting_admin', WAITING_USER: 'waiting_user', RESOLVED: 'resolved', CLOSED: 'closed' };
function getTickets() {
    var t = getData(DB_KEYS.SUPPORT);
    return Object.prototype.toString.call(t) === '[object Array]' ? t : [];
}
function saveTickets(list) { setData(DB_KEYS.SUPPORT, list); return list; }
function findTicket(id) {
    var list = getTickets();
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
}
function ticketsFor(userType, userId) {
    var list = getTickets(), out = [];
    for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t) continue;
        if (userType === 'reseller' && String(t.resellerId) === String(userId)) out.push(t);
        if (userType === 'supplier' && String(t.supplierId) === String(userId)) out.push(t);
    }
    out.sort(function (a, b) { return String(b.updatedAt || b.date || '').localeCompare(String(a.updatedAt || a.date || '')); });
    return out;
}
function ticketStatusLabel(s) {
    var map = { open: 'Open', waiting_admin: 'Waiting for Admin', waiting_user: 'Waiting for User', resolved: 'Resolved', closed: 'Closed' };
    return map[s] || 'Open';
}
function createTicket(fields) {
    fields = fields || {};
    if (!fields.subject) return { ok: false, message: 'Subject দিন।' };
    if (!fields.message) return { ok: false, message: 'Message লিখুন।' };
    var t = {
        id: 'TK' + Date.now(),
        resellerId: (fields.userType === 'reseller') ? fields.userId : null,
        supplierId: (fields.userType === 'supplier') ? fields.userId : null,
        userType: fields.userType || 'reseller',
        userId: fields.userId,
        userName: fields.userName || '',
        businessName: fields.businessName || '',
        subject: String(fields.subject).trim(),
        category: String(fields.category || 'General').trim(),
        orderId: fields.orderId ? String(fields.orderId) : '',
        message: String(fields.message),
        attachments: fields.attachments || [],
        thread: [{ from: 'user', text: String(fields.message), attachments: fields.attachments || [], at: new Date().toISOString() }],
        status: TICKET_STATUS.WAITING_ADMIN,
        date: new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    var list = getTickets();
    list.push(t);
    saveTickets(list);
    return { ok: true, ticket: t };
}
function addTicketReply(id, from, text, attachments) {
    var list = getTickets(), t = null;
    for (var i = 0; i < list.length; i++) { if (String(list[i].id) === String(id)) { t = list[i]; break; } }
    if (!t) return { ok: false, message: 'Ticket পাওয়া যায়নি।' };
    if (t.status === TICKET_STATUS.CLOSED) return { ok: false, message: 'Ticket বন্ধ হয়ে গেছে — আগে reopen করুন।' };
    if (!text && !(attachments && attachments.length)) return { ok: false, message: 'Message লিখুন।' };
    if (!t.thread) t.thread = [];
    t.thread.push({ from: from, text: String(text || ''), attachments: attachments || [], at: new Date().toISOString() });
    t.updatedAt = new Date().toISOString();
    t.status = (from === 'admin') ? TICKET_STATUS.WAITING_USER : TICKET_STATUS.WAITING_ADMIN;
    saveTickets(list);
    return { ok: true, ticket: t };
}
function setTicketStatus(id, status) {
    var list = getTickets();
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) !== String(id)) continue;
        list[i].status = status;
        list[i].updatedAt = new Date().toISOString();
        if (status === TICKET_STATUS.CLOSED) list[i].closedAt = new Date().toISOString();
        saveTickets(list);
        return { ok: true };
    }
    return { ok: false, message: 'Ticket পাওয়া যায়নি।' };
}
function openTicketCount() {
    var list = getTickets(), n = 0;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].status !== TICKET_STATUS.CLOSED && list[i].status !== TICKET_STATUS.RESOLVED) n++;
    return n;
}

/* ---------- PART 32 - 39: messages (reseller/supplier <-> admin) ----------
   ITEMS 5-9 — the Message system.
   A reseller/supplier writes to the admin from their own panel, optionally
   attaching ONE product as context (Product / Product ID / Product owner /
   Sender / sender type). With no product attached it is a General Message.
   Either way a thread is keyed by (userType, userId) so ONE tenant owns exactly
   ONE conversation with the admin, and the admin sees every conversation.
   TENANT PRIVACY: a thread is only ever readable by its own (userType,userId)
   and by the admin. Nothing here returns another tenant's thread.
   -------------------------------------------------------------------------- */
var MSG_SENDER_TYPE = { RESELLER: 'reseller', SUPPLIER: 'supplier', ADMIN: 'admin' };
/* Conversation lifecycle. A thread is ACTIVE until the admin ends it.
   ENDED is a STATUS ONLY — see msgSetThreadStatus: no message, image or
   context is ever removed. */
var MSG_CHAT_STATUS = { ACTIVE: 'active', ENDED: 'ended' };
/* Backward compatible: a thread written before this feature has no `status`,
   and an old conversation is by definition an active one. */
function msgThreadStatus(t) {
    if (!t) return MSG_CHAT_STATUS.ACTIVE;
    return (t.status === MSG_CHAT_STATUS.ENDED) ? MSG_CHAT_STATUS.ENDED : MSG_CHAT_STATUS.ACTIVE;
}
function msgThreadEnded(t) { return msgThreadStatus(t) === MSG_CHAT_STATUS.ENDED; }
function getThreads() {
    var m = getData(DB_KEYS.MESSAGES);
    if (Object.prototype.toString.call(m) === '[object Array]') return {};
    return (m && typeof m === 'object') ? m : {};
}
function saveThreads(obj) { setData(DB_KEYS.MESSAGES, obj); return obj; }
function msgThreadKey(userType, userId) { return String(userType) + '|' + String(userId); }
function getThread(userType, userId) {
    var all = getThreads();
    return all[msgThreadKey(userType, userId)] || null;
}

/* ==========================================================================
   MESSAGE RETENTION — a rolling 7-day timeline
   --------------------------------------------------------------------------
   A message is kept for exactly MSG_RETENTION_DAYS after it was sent and is
   then dropped automatically. The window ROLLS: what is said in week 1 goes at
   the end of week 1, what is said in week 2 goes at the end of week 2, and so
   on — an old message never drags a new one out with it, and a new message
   never rescues an old one.
   Nothing else about a conversation changes: the owner's name, the chat status
   and every still-fresh message stay exactly as they were.
   The sweep is run automatically at the end of this block (see the call right
   after purgeExpiredMessages), so it happens in every panel — admin, reseller
   and supplier — without any page having to call it. Every sidebar click is a
   full page load in this app, so in practice the sweep runs on each navigation.
   ========================================================================== */
var MSG_RETENTION_DAYS = 7;
var MSG_RETENTION_MS = MSG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/* Is this one message past the window? A message with no usable timestamp is
   NEVER dropped — deleting something we cannot date would be data loss. */
function msgIsExpired(at, now) {
    if (!at) return false;
    var t = Date.parse(String(at));
    if (isNaN(t)) return false;
    return ((now - t) >= MSG_RETENTION_MS);
}

/* Drop every message older than the retention window, across every thread.
   Returns { threads, removed } so a caller (and the test harness) can see what
   actually happened. Writes ONLY when something changed, so an ordinary page
   load costs one read and no write at all. */
function purgeExpiredMessages(now) {
    now = (typeof now === 'number') ? now : Date.now();
    var all = getThreads(), changed = false, removed = 0, empty = [];
    for (var k in all) {
        if (!Object.prototype.hasOwnProperty.call(all, k)) continue;
        var t = all[k];
        if (!t || Object.prototype.toString.call(t.messages) !== '[object Array]') continue;
        var keep = [];
        for (var i = 0; i < t.messages.length; i++) {
            if (msgIsExpired(t.messages[i] && t.messages[i].at, now)) removed++;
            else keep.push(t.messages[i]);
        }
        if (keep.length !== t.messages.length) {
            t.messages = keep;
            changed = true;
            /* A conversation whose every message has expired is gone entirely.
               Leaving a nameless, message-less row behind would be a ghost entry
               in the inbox and would keep the record alive for no reason. */
            if (!keep.length) empty.push(k);
        }
    }
    for (var j = 0; j < empty.length; j++) delete all[empty[j]];
    if (changed) saveThreads(all);
    return { threads: Object.keys(all).length, removed: removed };
}

/* Automatic sweep. This runs the moment app.js finishes parsing — i.e. BEFORE
   the panel's own inline script, so no page ever renders an expired message and
   no page has to remember to call this. app.js is loaded by every panel, so the
   retention window applies to the admin, reseller and supplier panels at once.
   Wrapped so a storage error can never break a page boot. */
try { purgeExpiredMessages(); } catch (e) { }

/* ==========================================================================
   MESSAGE IMAGE DISPLAY — never render a broken <img>
   --------------------------------------------------------------------------
   A message image can only be missing in one situation: it was spilled to the
   IndexedDB image store by a build that spilled unconditionally, on an origin
   where that store was not usable, so the `@img:` ref outlived its bytes.
   getData() already resolves every ref whose bytes ARE available, so an <img>
   still holding a ref is either (a) about to be fixed by rhResolveImgTags() or
   (b) genuinely gone. Both cases are handled without the page needing any logic:
     · rhImgLost(el) — onerror: swap in a plain "no longer available" note
     · rhImgBack(el) — onload : take that note away again
   The note is only added AFTER the image has already failed to load, so a ref
   that resolves a moment later still wins the race and the photo appears.
   ========================================================================== */
function rhImgLost(el) {
    try {
        if (!el || !el.parentNode) return;
        if (el.getAttribute('data-img-lost') === '1') return;
        el.setAttribute('data-img-lost', '1');
        el.style.display = 'none';
        var d = document.createElement('div');
        d.className = 'rh-img-lost';
        d.innerHTML = '<i class="fas fa-image"></i> ছবিটি আর পাওয়া যাচ্ছে না';
        el.parentNode.insertBefore(d, el.nextSibling);
    } catch (e) { }
}
function rhImgBack(el) {
    try {
        if (!el) return;
        if (el.getAttribute('data-img-lost') !== '1') return;
        el.removeAttribute('data-img-lost');
        el.style.display = '';
        var n = el.nextSibling;
        if (n && n.className === 'rh-img-lost' && n.parentNode) n.parentNode.removeChild(n);
    } catch (e) { }
}
/* Installed here so the admin, reseller and supplier panels all look the same
   without any of them carrying the rule. */
(function rhImgLostCss() {
    try {
        var st = document.createElement('style');
        st.textContent = '.rh-img-lost{display:inline-flex;align-items:center;gap:7px;margin-top:8px;padding:9px 13px;border-radius:11px;background:#f1f5f9;color:#64748b;font-size:12px;font-weight:500;border:1px dashed #cbd5e1}';
        (document.head || document.documentElement).appendChild(st);
    } catch (e) { }
})();

/* Who may read this thread? Only its own tenant and the admin. */
function canReadThread(viewerType, viewerId, thread) {
    if (!thread) return false;
    if (String(viewerType) === 'admin') return true;              /* admin sees all */
    return msgThreadKey(viewerType, viewerId) === String(thread.key);
}
/* Resolve the display name of a product's owner, from live DB data. */
function msgProductOwnerLabel(p) {
    if (!p) return '';
    var t = productOwnerType(p);
    var id = productOwnerId(p);
    if (t === 'reseller') {
        var r = findResellerById(id);
        return (r && (r.businessName || r.name)) || ('Reseller #' + id);
    }
    if (t === 'supplier') {
        var s = findSupplierById(id);
        /* mirror the reseller branch: the BUSINESS identity comes first
           (a supplier's shopName == a reseller's businessName), the person's
           own name is only the fallback. */
        return (s && (s.shopName || s.name)) || ('Supplier #' + id);
    }
    return 'ResellerHub';
}
/* Build the product-context block a message may carry. Reads the LIVE product
   so the admin always sees the current name/owner, never a stale copy. */
function msgProductContext(productId, senderType, senderId) {
    var ctx = {
        productId: productId ? String(productId) : '',
        productName: '', productOwnerType: '', productOwnerId: '', productOwnerName: '',
        senderType: senderType || '', senderId: (senderId === undefined || senderId === null) ? '' : String(senderId),
        isGeneral: !productId
    };
    if (!productId) return ctx;
    var p = null;
    var ps = asArray(getData(DB_KEYS.PRODUCTS));
    for (var i = 0; i < ps.length; i++) if (String(ps[i].id) === String(productId)) { p = ps[i]; break; }
    if (!p) return ctx;
    ctx.productName = String(p.name || '');
    ctx.productOwnerType = productOwnerType(p);
    ctx.productOwnerId = String(productOwnerId(p) === null || productOwnerId(p) === undefined ? '' : productOwnerId(p));
    ctx.productOwnerName = msgProductOwnerLabel(p);
    return ctx;
}
function ensureThread(userType, userId, userName, businessName) {
    var all = getThreads();
    var k = msgThreadKey(userType, userId);
    if (!all[k]) {
        all[k] = {
            key: k, userType: userType, userId: userId,
            userName: userName || '', businessName: businessName || '',
            /* a conversation starts ACTIVE; only msgSetThreadStatus changes it */
            status: MSG_CHAT_STATUS.ACTIVE, statusAt: '',
            messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        };
        saveThreads(all);
    } else {
        if (userName) all[k].userName = userName;
        if (businessName) all[k].businessName = businessName;
        saveThreads(all);
    }
    return all[k];
}
/* Products this tenant may attach as message context.
   reseller -> the products THEY own; supplier -> the products THEY own;
   admin -> everything. Never exposes another tenant's catalogue. */
function msgAttachableProducts(userType, userId) {
    var out = [];
    var ps = asArray(getData(DB_KEYS.PRODUCTS));
    if (String(userType) === 'admin') return ps.slice();
    for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (!p) continue;
        if (String(userType) === 'reseller' && isResellerProduct(p) && String(productOwnerId(p)) === String(userId)) out.push(p);
        else if (String(userType) === 'supplier' && String(productOwnerType(p)) === 'supplier' && String(productOwnerId(p)) === String(userId)) out.push(p);
    }
    return out;
}
/* --------------------------------------------------------------------------
   CONVERSATION STATUS — Active <-> Ended
   #17: this is the ONLY thing End Chat changes. The messages array, every
   attached image, the product context and the order context are left exactly
   as they were, so the full history stays readable afterwards.
   -------------------------------------------------------------------------- */
function msgSetThreadStatus(userType, userId, status) {
    status = (status === MSG_CHAT_STATUS.ENDED) ? MSG_CHAT_STATUS.ENDED : MSG_CHAT_STATUS.ACTIVE;
    var all = getThreads();
    var k = msgThreadKey(userType, userId);
    var t = all[k];
    if (!t) return { ok: false, message: 'Conversation পাওয়া যায়নি।' };
    t.status = status;
    t.statusAt = new Date().toISOString();
    saveThreads(all);
    return { ok: true, status: status };
}
function msgEndChat(userType, userId) { return msgSetThreadStatus(userType, userId, MSG_CHAT_STATUS.ENDED); }
function msgReopenChat(userType, userId) { return msgSetThreadStatus(userType, userId, MSG_CHAT_STATUS.ACTIVE); }

/* --------------------------------------------------------------------------
   ORDER CONTEXT  (#4 - #8, #12)
   Everything here is resolved from the EXISTING ownership fields via
   orderItemSource() / orderItemIsResellerOwned() / orderItemIsSupplier() —
   no product name matching, no hardcoded list.
   -------------------------------------------------------------------------- */
function msgSourceLabel(src) {
    var s = String(src || '').toLowerCase();
    if (s === 'reseller') return 'Reseller Product';
    if (s === 'supplier') return 'Supplier Product';
    if (s === 'admin') return 'Admin Product';
    return 'Product';
}
function msgVariantLabelOf(it) {
    if (!it) return '';
    var parts = [];
    if (it.size) parts.push('Size: ' + it.size);
    if (it.color) parts.push('Color: ' + it.color);
    if (!parts.length && it.variant) parts.push(String(it.variant));
    return parts.join(' · ');
}
/* SECURITY (#7, #10): may this tenant even SEE this order?
   reseller -> orders of their shop / containing their own products
   supplier -> orders carrying at least one of THEIR lines
   admin    -> everything.  Knowing an order number is not enough. */
function msgOrderVisibleTo(userType, userId, o) {
    if (!o) return false;
    var t = String(userType);
    if (t === 'admin') return true;
    if (t === 'reseller') return !!orderBelongsToReseller(o, userId);
    if (t === 'supplier') {
        var items = orderLineItems(o);
        for (var i = 0; i < items.length; i++) if (orderItemIsSupplier(items[i], userId)) return true;
        return false;
    }
    return false;
}
/* "Order #12345", "ORD-000123", "ord000123" and "12345" must all find
   ORD-000123 — so drop punctuation and a leading ORD/ORDER prefix from BOTH
   sides before comparing. */
function msgStripOrderPrefix(v) {
    var s = String(v === undefined || v === null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (s.indexOf('order') === 0) return s.slice(5);
    if (s.indexOf('ord') === 0) return s.slice(3);
    return s;
}
function msgNormalizeOrderQuery(q) {
    return msgStripOrderPrefix(q);
}
/* Orders this tenant may attach, optionally narrowed by an order number
   ("Order #12345", "ORD-000123", "12345" all match). ALREADY scoped —
   another reseller's / another supplier's order can never appear. */
/* PRIVACY (spec, 2026-09-14) — what a viewer may see of an order's OWN totals.
   A supplier must never learn a multi-supplier order's whole amount (a rival's
   sold price is recoverable by subtraction: 1600 − 900 = 700) nor the customer's
   identity — those are "the reseller's order details", which the supplier is not
   allowed to see. Both are therefore masked down to the supplier's OWN lines.
   Admin and reseller keep the real values, unchanged. */
function msgOrderViewTotals(o, userType, userId) {
    var amount = Number(o && o.amount) || 0;
    var customer = String((o && o.customer) || '');
    if (String(userType) !== 'supplier') return { amount: amount, customer: customer };
    if (!(typeof isMultiSupplierOrder === 'function' && isMultiSupplierOrder(o))) {
        return { amount: amount, customer: customer };
    }
    var items = orderLineItems(o), mine = 0;
    for (var i = 0; i < items.length; i++) {
        if (!orderItemIsSupplier(items[i], userId)) continue;
        mine += (Number(itemSellingPrice(items[i])) || 0) * (Number(items[i].qty) || 1);
    }
    return { amount: Math.round(mine), customer: '' };
}
function msgSearchableOrders(userType, userId, query) {
    var all = asArray(getData(DB_KEYS.ORDERS)), out = [];
    var qn = msgNormalizeOrderQuery(query);
    for (var i = 0; i < all.length; i++) {
        var o = all[i];
        if (!o) continue;
        if (!msgOrderVisibleTo(userType, userId, o)) continue;      /* #7, #10, #11 */
        if (qn) {
            var idn = msgStripOrderPrefix(o.id);
            if (idn.indexOf(qn) === -1) {
                /* also allow a plain substring hit on the untouched id */
                var raw = String(o.id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                if (raw.indexOf(qn) === -1) continue;
            }
        }
        /* PRIVACY (spec, 2026-09-14) — a supplier attaching a MULTI-SUPPLIER order
           must not learn the whole-order total (a rival's sold price is
           recoverable by subtraction: 1600 − 900 = 700) nor the customer's name.
           Both are "the reseller's order details". A shallow copy is returned so
           the stored record is never mutated. Admin / reseller are unchanged. */
        if (String(userType) === 'supplier' && typeof isMultiSupplierOrder === 'function' && isMultiSupplierOrder(o)) {
            var vt = msgOrderViewTotals(o, userType, userId), oc = {};
            for (var kk in o) if (Object.prototype.hasOwnProperty.call(o, kk)) oc[kk] = o[kk];
            oc.amount = vt.amount; oc.customer = vt.customer;
            out.push(oc);
        } else {
            out.push(o);
        }
    }
    out.sort(function (a, b) { return orderTimeMs(b) - orderTimeMs(a); });
    return out.slice(0, 25);
}
/* One order, line by line, with per-line complaint permission.
   #11 — the block is decided at ITEM level, so a mixed order keeps its
   supplier-owned line complainable while the reseller-owned line is refused. */
function msgAttachableOrderItems(userType, userId, orderId) {
    var o = findOrderById(orderId);
    if (!o) return [];
    if (!msgOrderVisibleTo(userType, userId, o)) return [];         /* #7, #10 */
    var items = orderLineItems(o), out = [];
    /* PRIVACY (spec, 2026-09-14) — on a MULTI-SUPPLIER order a supplier may see
       ONLY its own lines. A rival's product name / variant / quantity is another
       supplier's detail, and a reseller-owned line is the reseller's; neither may
       be listed — not even as a greyed-out "no permission" chip, because that
       still discloses the product name. Single-supplier orders keep their
       previous behaviour (the reseller-owned line stays listed, blocked), since
       that case is outside this spec. */
    var orderIsMulti = (typeof isMultiSupplierOrder === 'function') && isMultiSupplierOrder(o);
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        if (String(userType) === 'supplier' && orderIsMulti && !orderItemIsSupplier(it, userId)) continue;
        var src = orderItemSource(it) || 'admin';
        var allowed = true, reason = '';
        /* #9 / #10 — the hard business rule: a SUPPLIER may never open a
           complaint about a RESELLER-uploaded product. Applies to the line,
           so the rest of a mixed order stays complainable. */
        if (String(userType) === 'supplier' && orderItemIsResellerOwned(it)) {
            allowed = false;
            reason = 'এটি একটি Reseller-এর নিজের প্রোডাক্ট — Supplier এই লাইন নিয়ে complaint করতে পারবেন না।';
        }
        out.push({
            index: i,
            productId: (it.productId === undefined || it.productId === null) ? '' : String(it.productId),
            productName: String(it.name || it.productName || 'Product'),
            qty: Number(it.qty) || 1,
            variant: msgVariantLabelOf(it),
            source: src,
            sourceLabel: msgSourceLabel(src),
            allowed: allowed,
            blockedReason: reason
        });
    }
    return out;
}
/* #6 — the snapshot the admin sees: order number, status, total, and the
   selected line (product, variant, qty, source). */
function msgOrderContext(orderId, userType, userId, itemIndex) {
    var o = findOrderById(orderId);
    if (!o) return null;
    if (!msgOrderVisibleTo(userType, userId, o)) return null;
    var lines = msgAttachableOrderItems(userType, userId, orderId);
    var sel = null;
    if (itemIndex !== undefined && itemIndex !== null && itemIndex !== '') {
        for (var i = 0; i < lines.length; i++) {
            if (String(lines[i].index) === String(itemIndex)) { sel = lines[i]; break; }
        }
    }
    /* #3 — the admin must see the PRODUCT OWNER even when the sender attached
       only an order and no separate product. Resolved from the LIVE product row,
       never from a name typed anywhere. */
    var ownerType = '', ownerName = '';
    var selProduct = sel ? findProductById(sel.productId) : null;
    if (selProduct) {
        ownerType = productOwnerType(selProduct);
        ownerName = msgProductOwnerLabel(selProduct);
    } else if (sel) {
        ownerType = sel.source || '';
        ownerName = sel.sourceLabel || msgSourceLabel(sel.source);
    }
    /* PRIVACY (spec, 2026-09-14) — same masking as the picker list: on a
       MULTI-SUPPLIER order the supplier's context card carries only its OWN
       lines' worth, and no customer name at all. */
    var vt = msgOrderViewTotals(o, userType, userId);
    var c = {
        orderId: String(o.id), orderNumber: String(o.id),
        status: String(o.status || ''), date: String(o.date || ''),
        amount: vt.amount, customer: vt.customer,
        lineCount: lines.length,
        itemIndex: sel ? sel.index : '',
        itemProductId: sel ? sel.productId : '',
        itemProductName: sel ? sel.productName : '',
        itemVariant: sel ? sel.variant : '',
        itemQty: sel ? sel.qty : '',
        itemSource: sel ? sel.source : '',
        itemSourceLabel: sel ? sel.sourceLabel : '',
        itemProductOwnerType: ownerType,
        itemProductOwnerName: ownerName
    };
    return c;
}
/* #9/#10/#11 — may this tenant attach this order (and this line) at all?
   Called by sendChatMessage so the rule holds even if the UI is bypassed. */
function msgOrderComplaintAllowed(userType, userId, orderId, itemIndex) {
    var lines = msgAttachableOrderItems(userType, userId, orderId);
    if (!lines.length) return { allowed: false, message: 'অর্ডারটি পাওয়া যায়নি বা আপনার access নেই।' };
    if (String(userType) !== 'supplier') return { allowed: true };
    if (itemIndex !== undefined && itemIndex !== null && itemIndex !== '') {
        for (var i = 0; i < lines.length; i++) {
            if (String(lines[i].index) === String(itemIndex)) {
                return lines[i].allowed ? { allowed: true } : { allowed: false, message: lines[i].blockedReason };
            }
        }
    }
    for (var j = 0; j < lines.length; j++) if (lines[j].allowed) return { allowed: true };
    return { allowed: false, message: 'এই অর্ডারের কোনো লাইনই আপনার প্রোডাক্টের নয় — Reseller-এর প্রোডাক্ট নিয়ে complaint করা যাবে না।' };
}
/* #7 — may this tenant attach this product? Ownership is re-checked here,
   at the data layer, not just in the dropdown. */
function msgProductComplaintAllowed(userType, userId, productId) {
    if (!productId) return { allowed: true };
    if (String(userType) === 'admin') return { allowed: true };
    var ps = msgAttachableProducts(userType, userId);
    for (var i = 0; i < ps.length; i++) {
        if (String(ps[i].id) === String(productId)) {
            if (String(userType) === 'supplier') {
                var p = findProductById(productId);
                if (p && productOwnerType(p) === 'reseller') {
                    return { allowed: false, message: 'Reseller-এর প্রোডাক্ট নিয়ে Supplier complaint করতে পারবেন না।' };
                }
            }
            return { allowed: true };
        }
    }
    return { allowed: false, message: 'এই প্রোডাক্টটি আপনার নয় — attach করা যাবে না।' };
}

/* from: 'user' | 'admin'   — items 5-9 add optional product context + senderType
   v2 — meta.orderId / meta.orderItemIndex attach an ORDER, and BOTH the
   product and the order are validated at this (data) layer before anything is
   written. A caller that bypasses the UI is refused just the same. */
function sendChatMessage(userType, userId, from, text, image, orderId, meta) {
    text = String(text || '').trim();
    if (!text && !image) return { ok: false, message: 'Message লিখুন।' };
    meta = meta || {};
    var isAdmin = (from === 'admin');
    var actorType = isAdmin ? 'admin' : userType;
    var oid = String(meta.orderId || orderId || '');

    /* ---- validation (skipped for the admin, who owns every record) ---- */
    if (!isAdmin) {
        var pv = msgProductComplaintAllowed(userType, userId, meta.productId);
        if (!pv.allowed) return { ok: false, message: pv.message };
        if (oid) {
            var ov = msgOrderComplaintAllowed(userType, userId, oid, meta.orderItemIndex);
            if (!ov.allowed) return { ok: false, message: ov.message };
        }
    }

    var all = getThreads();
    var k = msgThreadKey(userType, userId);
    if (!all[k]) {
        all[k] = {
            key: k, userType: userType, userId: userId,
            userName: meta.userName || '', businessName: meta.businessName || '',
            status: MSG_CHAT_STATUS.ACTIVE, statusAt: '',
            messages: [], createdAt: new Date().toISOString()
        };
    }
    var t = all[k];
    if (meta.userName) t.userName = meta.userName;
    if (meta.businessName) t.businessName = meta.businessName;
    var ctx = msgProductContext(meta.productId, actorType, userId);
    var oct = oid ? msgOrderContext(oid, actorType, userId, meta.orderItemIndex) : null;
    if (oid && !oct) oct = { orderId: oid, orderNumber: oid };
    t.messages.push({
        id: 'M' + Date.now() + Math.floor(Math.random() * 1000),
        from: from, text: text, image: image || '', orderId: oid,
        orderItemIndex: (meta.orderItemIndex === undefined || meta.orderItemIndex === null || meta.orderItemIndex === '') ? '' : String(meta.orderItemIndex),
        orderContext: oct || null,
        senderType: isAdmin ? MSG_SENDER_TYPE.ADMIN : (meta.senderType || userType),
        productId: ctx.productId, productName: ctx.productName,
        productOwnerType: ctx.productOwnerType, productOwnerId: ctx.productOwnerId,
        productOwnerName: ctx.productOwnerName, isGeneral: ctx.isGeneral,
        at: new Date().toISOString(), read: false
    });
    t.updatedAt = new Date().toISOString();
    saveThreads(all);
    return { ok: true };
}
function markThreadRead(userType, userId, reader) {
    var all = getThreads();
    var k = msgThreadKey(userType, userId);
    if (!all[k]) return;
    for (var i = 0; i < all[k].messages.length; i++) {
        if (reader === 'admin' && all[k].messages[i].from === 'user') all[k].messages[i].read = true;
        if (reader === 'user' && all[k].messages[i].from === 'admin') all[k].messages[i].read = true;
    }
    saveThreads(all);
}
function unreadForUser(userType, userId) {
    var t = getThread(userType, userId);
    if (!t) return 0;
    var n = 0;
    for (var i = 0; i < t.messages.length; i++) if (t.messages[i].from === 'admin' && !t.messages[i].read) n++;
    return n;
}
function unreadForAdmin() {
    var all = getThreads(), n = 0;
    for (var k in all) {
        if (!Object.prototype.hasOwnProperty.call(all, k)) continue;
        var ms = all[k].messages || [];
        for (var i = 0; i < ms.length; i++) if (ms[i].from === 'user' && !ms[i].read) n++;
    }
    return n;
}
function allThreadsSorted() {
    var all = getThreads(), out = [];
    for (var k in all) { if (Object.prototype.hasOwnProperty.call(all, k)) out.push(all[k]); }
    out.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    return out;
}
/* Items 5-9 — admin inbox projection. One row per conversation, carrying who
   wrote, the product context of the LATEST product-bearing message, the message
   text, whether an image is attached, and the unread count. */
function adminMessageInbox() {
    var threads = allThreadsSorted(), out = [];
    for (var i = 0; i < threads.length; i++) {
        var t = threads[i];
        if (!t) continue;
        var ms = t.messages || [];
        if (!ms.length) continue;
        var last = ms[ms.length - 1];
        var lastProduct = null;
        for (var j = ms.length - 1; j >= 0; j--) {
            if (ms[j] && ms[j].productId) { lastProduct = ms[j]; break; }
        }
        var lastOrder = null;
        for (var q = ms.length - 1; q >= 0; q--) {
            if (ms[q] && ms[q].orderId) { lastOrder = ms[q]; break; }
        }
        var unread = 0;
        for (var u = 0; u < ms.length; u++) if (ms[u].from === 'user' && !ms[u].read) unread++;
        out.push({
            key: t.key, userType: t.userType, userId: t.userId,
            userName: t.userName || '', businessName: t.businessName || '',
            lastText: String((last && last.text) || ''),
            lastFrom: (last && last.from) || '',
            lastAt: (last && last.at) || t.updatedAt || '',
            hasImage: !!(last && last.image),
            messageCount: ms.length, unread: unread,
            productId: lastProduct ? lastProduct.productId : '',
            productName: lastProduct ? lastProduct.productName : '',
            productOwnerType: lastProduct ? lastProduct.productOwnerType : '',
            productOwnerName: lastProduct ? lastProduct.productOwnerName : '',
            isGeneral: !lastProduct,
            /* v2 — #15/#16: the admin list must show the chat status and
               whether an order is attached, without opening the thread. */
            status: msgThreadStatus(t),
            ended: msgThreadEnded(t),
            statusAt: t.statusAt || '',
            orderId: lastOrder ? lastOrder.orderId : '',
            orderNumber: lastOrder ? lastOrder.orderId : '',
            orderStatus: lastOrder ? lastOrder.status : ''
        });
    }
    /* newest conversation first, unread ahead of read */
    out.sort(function (a, b) {
        if ((b.unread > 0) !== (a.unread > 0)) return (b.unread > 0) ? 1 : -1;
        return String(b.lastAt || '').localeCompare(String(a.lastAt || ''));
    });
    return out;
}

/* ==========================================================================
   RESELLER CUSTOMER INVOICE  (PART 22 - 31)
   --------------------------------------------------------------------------
   CRITICAL: this document NEVER contains a cost / buying / wholesale price,
   commission or profit. It only shows what the customer is expected to pay.
   ========================================================================== */
function resellerInvoiceData(o, reseller) {
    var items = [];
    if (o && o.items && o.items.length) {
        for (var i = 0; i < o.items.length; i++) {
            var it = o.items[i] || {};
            /* PART 25 — retail (customer) price only; never it.price / it.cost */
            var retail = Number(it.resale || it.customer_price || 0);
            var qty = Number(it.qty) || 1;
            items.push({
                name: String(it.name || 'Product'),
                qty: qty,
                retail: retail,
                line: retail * qty,
                variant: [it.size, it.color, it.variant].filter(function (x) { return !!x; }).join(' / ')
            });
        }
    } else if (o) {
        var r2 = Number(o.resale || o.productPrice || 0);
        var q2 = Number(o.qty) || 1;
        items.push({ name: String(o.productName || 'Product'), qty: q2, retail: r2, line: r2 * q2, variant: [o.size, o.color].filter(function (x) { return !!x; }).join(' / ') });
    }
    var productTotal = 0;
    for (var j = 0; j < items.length; j++) productTotal += items[j].line;
    var shipping = Number(o && o.shippingCharge) || 0;
    /* PART 28 — the stored order amount is the authoritative final payable */
    var stored = Number(o && o.amount);
    var totalPayable = (o && o.amount !== undefined && o.amount !== null && !isNaN(stored) && stored > 0) ? stored : (productTotal + shipping);
    var rs = reseller || {};
    return {
        orderId: o ? String(o.id) : '',
        date: (o && o.date) ? String(o.date).slice(0, 10) : '',
        business: rs.businessName || rs.business || rs.shop_name || rs.shopName || rs.name || 'My Shop',
        phone: rs.phone || rs.shop_phone || '',
        address: rs.shop_address || rs.address || '',
        customer: (o && o.customer) || '',
        items: items,
        productTotal: productTotal,
        shippingCharge: shipping,
        totalPayable: totalPayable,
        thankYou: 'Thank You For Your Order!'
    };
}
function resellerInvoiceHtml(o, reseller) {
    var d = resellerInvoiceData(o, reseller);
    var esc = function (v) {
        return String(v === undefined || v === null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    var money = function (n) { return '&#2547;' + (Number(n) || 0).toLocaleString('en-IN'); };
    var rows = '';
    for (var i = 0; i < d.items.length; i++) {
        var it = d.items[i];
        rows += '<tr><td class="pn">' + esc(it.name) + (it.variant ? '<span class="vr">' + esc(it.variant) + '</span>' : '') + '</td>' +
            '<td class="ct">' + esc(it.qty) + '</td><td class="pr">' + money(it.line) + '</td></tr>';
    }
    if (!rows) rows = '<tr><td class="pn">—</td><td class="ct">—</td><td class="pr">—</td></tr>';

    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ' + esc(d.orderId) + '</title><style>' +
        '*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
        '@page{size:A4;margin:0}' +
        'body{font-family:Inter,Arial,Helvetica,sans-serif;color:#0f172a;background:#fff;padding:14mm}' +
        '.hd{text-align:center;border-bottom:3px solid #0f172a;padding-bottom:14px;margin-bottom:6px}' +
        '.hd h1{font-size:22px;font-weight:900;letter-spacing:.5px;line-height:1.2}' +
        '.hd .ph{font-size:12px;color:#475569;margin-top:5px}' +
        '.hd .ad{font-size:11px;color:#64748b;margin-top:3px}' +
        '.inv{text-align:center;font-size:13px;font-weight:900;letter-spacing:5px;color:#64748b;margin:16px 0 4px}' +
        '.meta{display:flex;justify-content:space-between;gap:14px;font-size:11px;color:#64748b;margin:12px 0 16px}' +
        '.meta b{color:#0f172a}' +
        'table{width:100%;border-collapse:collapse}' +
        'thead th{background:#f1f5f9;font-size:9.5px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:#64748b;text-align:left;padding:9px 8px;border-bottom:1.5px solid #cbd5e1}' +
        'thead th.ct{text-align:center}thead th.pr{text-align:right}' +
        'tbody td{font-size:12.5px;padding:10px 8px;border-bottom:1px dashed #e2e8f0;vertical-align:top}' +
        '.pn{font-weight:700}.vr{display:block;font-size:9.5px;color:#94a3b8;font-weight:600;margin-top:2px}' +
        '.ct{text-align:center;font-weight:800;white-space:nowrap}' +
        '.pr{text-align:right;font-weight:900;white-space:nowrap}' +
        '.sums{margin-top:18px;margin-left:auto;width:300px}' +
        '.srow{display:flex;justify-content:space-between;font-size:12px;padding:7px 0;border-bottom:1px solid #e2e8f0}' +
        '.srow.total{border-bottom:none;border-top:2.5px solid #0f172a;margin-top:6px;padding-top:11px;font-size:17px;font-weight:900}' +
        '.thx{margin-top:34px;border-top:2px solid #0f172a;padding-top:14px;text-align:center;font-size:14px;font-weight:900}' +
        '.thx small{display:block;font-size:10px;color:#64748b;font-weight:600;margin-top:4px}' +
        '@media print{ body{padding:14mm} }' +
        '</style></head><body>' +
        '<div class="hd"><h1>' + esc(d.business) + '</h1>' +
        (d.phone ? '<div class="ph">' + esc(d.phone) + '</div>' : '') +
        (d.address ? '<div class="ad">' + esc(d.address) + '</div>' : '') + '</div>' +
        '<div class="inv">INVOICE</div>' +
        '<div class="meta"><span>Invoice: <b>' + esc(d.orderId) + '</b></span>' +
        '<span>Date: <b>' + esc(d.date) + '</b></span>' +
        (d.customer ? '<span>Customer: <b>' + esc(d.customer) + '</b></span>' : '') + '</div>' +
        '<table><thead><tr><th>Product</th><th class="ct">Qty</th><th class="pr">Price</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="sums">' +
        '<div class="srow"><span>Delivery Charge</span><b>' + money(d.shippingCharge) + '</b></div>' +
        '<div class="srow total"><span>TOTAL PAYABLE</span><b>' + money(d.totalPayable) + '</b></div>' +
        '</div>' +
        '<div class="thx">' + esc(d.thankYou) + '<small>Check the product in front of the delivery man before receiving.</small></div>' +
        '</body></html>';
}

/* ==========================================================================
   PLATFORM UPDATE — PART 2 (visibility matrix completion)
   ========================================================================== */

/* PART 1, 2 — a reseller's "All Products" = admin + supplier + THEIR OWN.
   Another reseller's product is never included. Out-of-stock own products are
   hidden from this browsing list (PART 31) but stay in the admin management list. */
function resellerCatalogProducts(rid) {
    var out = [], seen = {};
    var cat = catalogProducts();                 /* admin + supplier, in stock */
    for (var i = 0; i < cat.length; i++) { out.push(cat[i]); seen[String(cat[i].id)] = 1; }
    var all = getData(DB_KEYS.PRODUCTS) || [];
    for (var j = 0; j < all.length; j++) {
        var p = all[j];
        if (!isResellerOwnProduct(p, rid)) continue;      /* PART 2, 17 */
        if (seen[String(p.id)]) continue;
        if (!productInStock(p)) continue;                 /* PART 31 */
        seen[String(p.id)] = 1;
        out.push(p);
    }
    return out;
}

/* PART 3 — the admin's normal All Products list shows admin + supplier only.
   It deliberately INCLUDES out-of-stock rows (the admin must manage them). */
function adminCatalogProducts() {
    var ps = getData(DB_KEYS.PRODUCTS) || [], out = [];
    for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (!p) continue;
        if (isResellerProduct(p)) continue;               /* never mixed in */
        out.push(p);
    }
    return out;
}

/* PART 4, 30, 31, 35 — the admin's My Shop Products management list.
   Shows EVERY reseller-owned product (including out-of-stock) with owner info,
   optionally narrowed to one reseller. */
function adminMyShopProducts(resellerId) {
    var ps = getData(DB_KEYS.PRODUCTS) || [], out = [];
    for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (!p || !isResellerProduct(p)) continue;
        if (resellerId !== undefined && resellerId !== null && resellerId !== '' &&
            String(productOwnerId(p)) !== String(resellerId)) continue;
        out.push(p);
    }
    return out;
}
/* Owner lookup used by the admin management views (never mutates ownership). */
function resellerProductOwnerLabel(p) {
    var rid = productOwnerId(p);
    if (rid === null) return '—';
    var list = getData(DB_KEYS.RESELLERS) || [];
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) !== String(rid)) continue;
        return list[i].businessName || list[i].business || list[i].shop_name || list[i].shopName || list[i].name || ('#' + rid);
    }
    return '#' + rid;
}
/* PART 8 — an admin edit must never change who owns the product. */
function preserveProductOwnership(original, edited) {
    if (!original || !edited) return edited;
    edited.product_owner_type = productOwnerType(original);
    edited.product_owner_id = productOwnerId(original);
    edited.ownerResellerId = original.ownerResellerId;
    edited.supplierId = original.supplierId;
    edited.product_source = original.product_source || productOwnerType(original);
    return edited;
}
/* PART 32 — never hard-delete a product that has order history. */
function productHasOrders(productId) {
    var orders = getData(DB_KEYS.ORDERS) || [];
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o) continue;
        if (o.items && o.items.length) {
            for (var j = 0; j < o.items.length; j++) {
                if (String((o.items[j] || {}).productId) === String(productId)) return true;
            }
        }
        if (String(o.productId) === String(productId)) return true;
    }
    return false;
}
/* Safe removal: archive (soft-delete) when orders exist, hard-delete otherwise. */
function safeDeleteProduct(productId) {
    var ps = getData(DB_KEYS.PRODUCTS) || [], found = false, archived = false, out = [];
    for (var i = 0; i < ps.length; i++) {
        if (String(ps[i].id) !== String(productId)) { out.push(ps[i]); continue; }
        found = true;
        if (productHasOrders(productId)) {
            ps[i].is_active = false;
            ps[i].archived = true;
            ps[i].archivedAt = new Date().toISOString();
            out.push(ps[i]);
            archived = true;
        }
    }
    if (!found) return { ok: false, message: 'Product পাওয়া যায়নি।' };
    setData(DB_KEYS.PRODUCTS, out);
    return { ok: true, archived: archived };
}

/* PART 12, 13, 38 — the admin's normal Orders list must never contain an order
   that includes a reseller-owned product line (item-level check, so a mixed
   order cannot leak the reseller's part into the platform list). */
function orderHasResellerOwnedLine(o) {
    if (!o) return false;
    if (o.items && o.items.length) {
        for (var i = 0; i < o.items.length; i++) {
            var it = o.items[i] || {};
            if (it.product_owner_type === 'reseller') return true;
            var p = findProductById(it.productId);
            if (p && isResellerProduct(p)) return true;
        }
        return false;
    }
    var p2 = findProductById(o.productId);
    return !!(p2 && isResellerProduct(p2));
}
function adminNormalOrders() {
    /* Order-item level routing (see platformOrderView): a mixed order is NOT
       dropped any more — only its reseller-owned lines are withheld, so its
       supplier/admin items still show in Admin → All Orders. A pure
       own-product order (no platform item) is still excluded.

       MULTI-SUPPLIER ORDERS ARE ROUTED TO THEIR OWN PAGE ONLY (spec, 2026-09-14):
       an order carrying 2+ DIFFERENT suppliers is fulfilled by the platform
       (collection, not per-supplier shipping) and has a dedicated page. Listing
       it here as well would duplicate it and invite line-by-line fulfilment, so
       it is excluded from All Orders and appears in Admin → Multi-Supplier
       Orders alone. isMultiSupplierOrder() is the SAME predicate that page uses,
       so the list and the page can never disagree. */
    var orders = getData(DB_KEYS.ORDERS) || [], out = [];
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o) continue;
        if (typeof isMultiSupplierOrder === 'function' && isMultiSupplierOrder(o)) continue;
        var v = platformOrderView(o);
        if (!v) continue;                                 /* pure own-product -> My Shop Orders only */
        out.push(v);
    }
    return out;
}

/* ---------------------------------------------------------------------------
   ADMIN — ORDER-ITEM SOURCE CLASSIFICATION (single source of truth)
   ---------------------------------------------------------------------------
   The Admin panel must show, in Product-wise Summary and All Orders, ONLY
   platform products (admin + supplier). A reseller's own uploaded product never
   appears there — not even the reseller line of a mixed order. Those lines are
   routed to Admin -> My Shop Orders instead.

   This lives in app.js (the shared data layer every page loads) so the split is
   a backend-level rule, not per-page UI filtering. All three helpers read the
   EXISTING ownership fields (product_source / product_owner_type /
   product_owner_id / shop_id / ownerResellerId) — no new ownership system.

   Item-level truth table:
     'reseller' -> a reseller-owned line  (Admin platform views: HIDDEN)
     'admin' / 'supplier' -> a platform line (Admin platform views: SHOWN)
   --------------------------------------------------------------------------- */

/* Resolve ONE order line's source. Falls back to the live product row when the
   line itself carries no source (legacy single-product orders). */
function orderItemSource(it) {
    if (!it) return '';
    var t = String(it.product_owner_type || it.product_source || it.productOwnerType || '').toLowerCase();
    if (t === 'reseller' || t === 'admin' || t === 'supplier') return t;
    var p = findProductById(it.productId);
    if (p) return productOwnerType(p);           /* 'admin' | 'supplier' | 'reseller' */
    return '';
}
/* TRUE iff this one line is a reseller-owned (My Shop) product line. */
function orderItemIsResellerOwned(it) {
    if (!it) return false;
    if (orderItemSource(it) === 'reseller') return true;
    /* legacy / partial rows */
    var rid = (it.product_owner_id !== undefined && it.product_owner_id !== null) ? it.product_owner_id : it.ownerResellerId;
    var t = String(it.product_owner_type || it.product_source || '').toLowerCase();
    if (rid !== undefined && rid !== null && rid !== '' && t !== 'admin' && t !== 'supplier') return true;
    return false;
}
/* Platform-only (admin + supplier) lines of an order — what the Admin
   Product-wise Summary is allowed to aggregate. Reseller lines are dropped
   INDIVIDUALLY, so a mixed order contributes only its platform part. */
function adminSummaryItems(o) {
    var items = orderLineItems(o), out = [];
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        if (orderItemIsResellerOwned(it)) continue;
        out.push(it);
    }
    return out;
}
/* Every order that carries at least one reseller-owned line -> Admin My Shop
   Orders. Covers BOTH the pure-own order and the MIXED order (which
   orderHasResellerOwnedLine already keeps out of All Orders — so without this
   it would be visible in NEITHER admin page). Other resellers' orders are not
   filtered here on purpose: My Shop Orders is the all-reseller admin view, and
   it shows the owning reseller per row. */
function adminMyShopOrders() {
    var orders = getData(DB_KEYS.ORDERS) || [], out = [];
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o) continue;
        if (orderHasResellerOwnedLine(o)) out.push(o);
    }
    return out;
}
/* Platform (admin/supplier) ORDERS for the admin side.
   ---------------------------------------------------------------------------
   ROOT-CAUSE FIX (mixed-product cart/order visibility):
   adminNormalOrders() drops the WHOLE order as soon as it carries a
   reseller-owned line. That is correct for a pure own-product order, but for a
   MIXED order it also hid the admin/supplier items — the supplier/admin product
   never reached Admin → All Orders.

   Visibility must be decided at the ORDER-ITEM level, never on the whole order:
     Reseller item  -> owner reseller's My Shop Orders
     Supplier item  -> All Orders
     Admin item     -> All Orders
   So this returns every order, each PROJECTED onto its platform (admin/supplier)
   items only, and only when at least one such item exists. Order identity is
   preserved (spread copy, same id/date/customer/status) — nothing is mutated,
   duplicated on disk or deleted. */
function platformOrderView(o) {
    if (!o) return null;
    var platform = adminSummaryItems(o);          /* admin + supplier lines only */
    if (!platform.length) return null;            /* pure own-product order */
    var copy = {};
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) copy[k] = o[k]; }
    copy.items = platform;
    copy._platform_view = true;                   /* render hint, not persisted */
    copy._platform_item_count = platform.length;
    return copy;
}
function adminPlatformOrders() {
    var orders = getData(DB_KEYS.ORDERS) || [], out = [];
    for (var i = 0; i < orders.length; i++) {
        var v = platformOrderView(orders[i]);
        if (v) out.push(v);
    }
    return out;
}
/* Does this order carry at least one platform (admin/supplier) item? Used by
   Admin → All Orders so a mixed order is still listed (with its platform items)
   instead of vanishing. */
function orderHasPlatformItem(o) {
    return adminSummaryItems(o).length > 0;
}

/* ---------------------------------------------------------------------------
   SUPPLIER — ORDER-ITEM SOURCE CLASSIFICATION (single source of truth)
   ---------------------------------------------------------------------------
   Same rule as the admin side, but restricted to ONE supplier: a supplier must
   see the supplier-owned lines of every order — INCLUDING a mixed order whose
   other lines belong to the admin or to a reseller. Matching is by product id
   AND by the line's own supplier field, so an order is never lost because the
   dashboard compared a product id against a differently-typed key.
   --------------------------------------------------------------------------- */
/* Is this order line fulfilled by supplier `sid`? */
/* ---------------------------------------------------------------------------
   SUPPLIER-LINE RESOLUTION — ONE rule, shared by orderItemIsSupplier() and
   orderItemSupplierId(), so the two can never disagree.

   Two sources of truth exist for "which supplier owns this order line":
     1. the LIVE product row  (authoritative while it still carries an owner)
     2. the ORDER LINE's own frozen snapshot, written at checkout:
        product_owner_type / product_source + product_owner_id / supplierId

   The line's snapshot used to be consulted ONLY when the product row was gone.
   If the row survived but had lost its supplier link — a supplier product
   re-saved without `supplierId`, which is easy to hit because
   productOwnerType() returns 'admin' as its DEFAULT for "nothing known" — both
   helpers gave up and returned no supplier at all. A two-supplier order was
   then not recognised as multi-supplier, so it never reached the Multi-Supplier
   Orders page, and the supplier did not see it in All Orders either.
   Now the line is consulted whenever the row says nothing about ownership.
   --------------------------------------------------------------------------- */
function productHasOwnerInfo(p) {
    if (!p) return false;
    if (p.supplierId !== undefined && p.supplierId !== null && p.supplierId !== '') return true;
    if (p.supplier_id !== undefined && p.supplier_id !== null && p.supplier_id !== '') return true;
    if (p.ownerResellerId !== undefined && p.ownerResellerId !== null && p.ownerResellerId !== '') return true;
    if (p.product_owner_id !== undefined && p.product_owner_id !== null && p.product_owner_id !== '') return true;
    if (p.product_owner_type !== undefined && p.product_owner_type !== null && p.product_owner_type !== '') return true;
    if (p.productOwnerType !== undefined && p.productOwnerType !== null && p.productOwnerType !== '') return true;
    return false;
}
/* The line's own declaration of its supplier. Returns '' unless the line
   positively says 'supplier' AND carries an owner id. */
function supplierIdFromLine(it, lineSup) {
    if (!it) return '';
    var t = String(it.product_owner_type || it.product_source || it.productOwnerType || '').toLowerCase();
    if (t !== 'supplier') return '';
    var oid = (it.product_owner_id !== undefined && it.product_owner_id !== null) ? it.product_owner_id : lineSup;
    return (oid === null || oid === undefined || oid === '') ? '' : String(oid);
}
function orderItemIsSupplier(it, sid) {
    if (!it) return false;
    var pid = (it.productId !== undefined && it.productId !== null) ? it.productId : it.product_id;
    var p = findProductById(pid);
    var lineSup = (it.supplierId !== undefined && it.supplierId !== null) ? it.supplierId
                : (it.supplier_id !== undefined && it.supplier_id !== null) ? it.supplier_id : null;
    /* the product record is authoritative when it exists */
    if (p) {
        var pSup = (p.supplierId !== undefined && p.supplierId !== null) ? p.supplierId
                 : (p.supplier_id !== undefined && p.supplier_id !== null) ? p.supplier_id : null;
        if (pSup !== null && sid !== undefined && sid !== null && String(pSup) === String(sid)) return true;
        /* a reseller-owned or admin product is never a supplier line */
        if (productOwnerType(p) === 'reseller') return false;
        if (pSup === null && lineSup !== null && String(lineSup) === String(sid)) return true;
        if (pSup === null) {
            /* The row exists but carries no ownership information at all — it has
               lost its supplier link. Fall back to the line's frozen snapshot,
               exactly as when the row is gone. */
            if (!productHasOwnerInfo(p)) {
                var lsup = supplierIdFromLine(it, lineSup);
                return lsup !== '' && sid !== undefined && sid !== null && String(lsup) === String(sid);
            }
            return false;
        }
    }
    return lineSup !== null && sid !== undefined && sid !== null && String(lineSup) === String(sid);
}
/* ==========================================================================
   MY SHOP CUSTOMER <-> RESELLER CHAT
   --------------------------------------------------------------------------
   Same isolation model as the customer accounts:

       rh_shop_chats = { "<resellerId>": { "<convId>": conversation } }

   Every helper takes `rid` FIRST and reads/writes only that shop's bucket, so a
   customer chatting with one reseller can never appear in another reseller's
   panel. A message may carry text, an image and an optional order id.
   =========================================================================== */
function allShopChats() {
    var s = getData(DB_KEYS.SHOP_CHATS);
    if (!s || typeof s !== 'object' || Object.prototype.toString.call(s) === '[object Array]') return {};
    return s;
}
function saveAllShopChats(o) { setData(DB_KEYS.SHOP_CHATS, o); return o; }
function shopChats(rid) {
    var all = allShopChats();
    var m = all[String(rid)];
    return (m && typeof m === 'object') ? m : {};
}
function saveShopChats(rid, map) {
    var all = allShopChats();
    all[String(rid)] = map;
    return saveAllShopChats(all);
}
/* One conversation per (shop, customer). */
function shopChatFind(rid, customerId) {
    var m = shopChats(rid);
    for (var k in m) {
        if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
        if (String(m[k].customerId) === String(customerId)) return m[k];
    }
    return null;
}
function shopChatStart(rid, cust) {
    var c = shopChatFind(rid, cust.id);
    if (c) return c;
    var m = shopChats(rid);
    var id = 'CH' + Date.now() + Math.floor(Math.random() * 1000);
    c = {
        id: id, shopId: String(rid),
        customerId: String(cust.id),
        customerName: String(cust.name || ''),
        customerPhone: String(cust.phone || ''),
        orderId: '', status: 'open',
        messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    m[id] = c;
    saveShopChats(rid, m);
    return c;
}
/* Send a message. `from` is 'customer' or 'reseller'. */
function shopChatSend(rid, convId, from, text, image, orderId) {
    var m = shopChats(rid);
    var c = m[convId];
    if (!c) return { ok: false, message: 'Conversation পাওয়া যায়নি।' };
    text = String(text || '').trim();
    if (!text && !image) return { ok: false, message: 'মেসেজ বা ছবি দিন।' };
    c.messages.push({
        id: 'M' + Date.now() + Math.floor(Math.random() * 1000),
        from: (from === 'reseller') ? 'reseller' : 'customer',
        text: text, image: image || '',
        orderId: orderId ? String(orderId) : '',
        at: new Date().toISOString(), read: false
    });
    c.updatedAt = new Date().toISOString();
    if (orderId) c.orderId = String(orderId);
    m[convId] = c;
    saveShopChats(rid, m);
    return { ok: true, conversation: c };
}
/* #18 — END CHAT must NEVER destroy history.
   The conversation is only marked `ended`; every message, image, name, phone,
   product/order context and timestamp stays in the database so the Admin /
   Reseller inbox keeps the full record forever.
   The CUSTOMER view is emptied separately via `customerClearedAt` — anything
   sent before that instant is hidden from the storefront widget only. */
function shopChatEnd(rid, convId) {
    var m = shopChats(rid);
    var c = m[convId];
    if (!c) return { ok: false, message: 'Conversation পাওয়া যায়নি।' };
    c.status = 'ended';
    c.endedAt = new Date().toISOString();
    /* Part 11 — ending a chat must actually DELETE that conversation's previous
       messages. The old behaviour only recorded a cut-off index and left the
       array intact, so the reseller still saw the whole history after pressing
       End Chat. `clearedCount` keeps a record of how many were removed.
       Scope: ONLY this conversation (m[convId]) is touched — every other
       customer's thread, in this shop and in every other shop, is untouched. */
    c.clearedCount = (c.messages || []).length;
    c.messages = [];
    c.customerClearedCount = 0;
    c.updatedAt = c.endedAt;
    m[convId] = c;
    saveShopChats(rid, m);
    return { ok: true, conversation: c };
}
/* #15 — a customer may message the reseller WITHOUT an account. A guest
   identity is derived from the shop + phone, so the thread is still scoped to
   that one shop and can never collide with another reseller's conversation. */
function shopGuestPhone(phone) {
    var d = String(phone === undefined || phone === null ? '' : phone).replace(/\D/g, '');
    if (d.charAt(0) === '0') d = '88' + d;
    return d;
}
function shopGuestId(rid, phone) { return 'guest:' + String(rid) + ':' + shopGuestPhone(phone); }
function shopChatStartGuest(rid, name, phone) {
    var d = shopGuestPhone(phone);
    if (!d) return { ok: false, message: 'সঠিক ফোন নম্বর দিন।' };
    var c = shopChatStart(rid, { id: shopGuestId(rid, d), name: String(name || '').trim(), phone: d });
    c.guest = true;
    var m = shopChats(rid); m[c.id] = c; saveShopChats(rid, m);
    /* 2026-09-18 — a guest who messages the shop leaves a name and a number;
       remember them so the reseller can reach out or order for them later.
       NOTE: shopChatStart() stores the name as `customerName`, not `name` — reading
       `c.name` here silently saved the customer with NO name at all. */
    try { ciRemember(rid, { name: c.customerName || name, phone: d }, 'chat'); } catch (e) { }
    return { ok: true, conversation: c };
}

/* The storefront-side view of a conversation: hides everything sent before the
   last End Chat, but the stored record (and therefore the Admin inbox) keeps
   everything. */
function shopChatCustomerView(c) {
    if (!c) return null;
    var cut = Number(c.customerClearedCount || 0);
    var ms = c.messages || [];
    return {
        status: c.status || 'open',
        ended: c.status === 'ended',
        messages: cut ? ms.slice(cut) : ms.slice()
    };
}
function shopChatMarkRead(rid, convId, reader) {
    var m = shopChats(rid);
    var c = m[convId];
    if (!c) return;
    for (var i = 0; i < c.messages.length; i++) {
        if (reader === 'reseller' && c.messages[i].from === 'customer') c.messages[i].read = true;
        if (reader === 'customer' && c.messages[i].from === 'reseller') c.messages[i].read = true;
    }
    m[convId] = c;
    saveShopChats(rid, m);
}
/* Newest first for the reseller's inbox. */
function shopChatList(rid) {
    var m = shopChats(rid), out = [];
    for (var k in m) { if (Object.prototype.hasOwnProperty.call(m, k)) out.push(m[k]); }
    out.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    return out;
}
function shopChatUnread(rid) {
    var list = shopChatList(rid), n = 0;
    for (var i = 0; i < list.length; i++) {
        var ms = list[i].messages || [];
        for (var j = 0; j < ms.length; j++) if (ms[j].from === 'customer' && !ms[j].read) n++;
    }
    return n;
}

/* ==========================================================================
   CUSTOMER-MESSAGE BADGE — how many DIFFERENT CUSTOMERS have written in.
   --------------------------------------------------------------------------
   `shopChatUnread()` (above) counts unread MESSAGES. The shop owner asked for
   the nav icon to count PEOPLE instead — and specifically the people whose
   message has NOT been read yet:

       10 customers write, reseller reads 5  ->   5
       12 customers write, reseller reads 2  ->  10
        1 customer writes 100 times          ->   1   (still one customer)

   So the badge is UNREAD-only: `resellerCustomerMessageBadgeCount()` passes
   `{ unreadOnly: true }`. Opening a thread is what records the read, via
   `shopChatMarkRead(rid, convId, 'reseller')`.

   Identity: this codebase identifies a storefront customer by PHONE — an
   account customer carries `customer.phone`, a guest is
   `guest:<shop>:<phone>` — so the normalised phone is the de-duplication key.
   Falling back to `customerId`, then to the conversation id, keeps a thread
   that somehow carries no phone from collapsing into another thread.
   ========================================================================== */
function shopChatCustomerKey(c) {
    if (!c) return '';
    var ph = String(c.customerPhone || '').replace(/\D/g, '');
    if (ph) {
        if (ph.charAt(0) === '0') ph = '88' + ph;   /* same rule as shopGuestPhone() */
        return 'p:' + ph;
    }
    var cid = String(c.customerId || '').trim();
    if (cid) return 'c:' + cid;
    return c.id ? ('v:' + String(c.id)) : '';
}
function shopChatHasCustomerMessage(c) {
    var ms = (c && c.messages) || [];
    for (var i = 0; i < ms.length; i++) if (ms[i] && ms[i].from === 'customer') return true;
    return false;
}
/* Distinct customers with at least one message FROM the customer.
   `opts.unreadOnly` narrows it to customers still holding an UNREAD message.
   The nav badge USES that mode: a customer stops being counted the moment the
   reseller opens their thread (shopChatMarkRead). The total-count mode is kept
   because other views may want "everyone who ever wrote". */
function shopChatCustomerCount(rid, opts) {
    var unreadOnly = !!(opts && opts.unreadOnly);
    var list = shopChatList(rid), seen = {}, n = 0;
    for (var i = 0; i < list.length; i++) {
        var c = list[i], hit = false;
        if (unreadOnly) {
            var ms = c.messages || [];
            for (var j = 0; j < ms.length; j++) {
                if (ms[j] && ms[j].from === 'customer' && !ms[j].read) { hit = true; break; }
            }
        } else {
            hit = shopChatHasCustomerMessage(c);
        }
        if (!hit) continue;
        var k = shopChatCustomerKey(c);
        if (!k || seen[k]) continue;
        seen[k] = 1; n++;
    }
    return n;
}
function resellerCustomerMessageBadgeCount(rid) { return shopChatCustomerCount(rid, { unreadOnly: true }); }

/* ==========================================================================
   MY SHOP CUSTOMER ACCOUNTS
   --------------------------------------------------------------------------
   Each My Shop is treated as its own website, so a customer account belongs to
   ONE shop only. Storage is BUCKETED BY SHOP:

       rh_shop_customers = { "<resellerId>": [ customer, ... ] }

   Every function takes `rid` (the shop) as its FIRST argument and reads/writes
   ONLY that shop's bucket. There is deliberately no "find a customer by id
   across all shops" helper — a client-supplied id, rid or phone can therefore
   never reach another shop's customer, order or profile.
   A customer is identified by phone (the same field the checkout already
   stores on the order), which is how orders are linked back to the account.
   =========================================================================== */
function allShopCustomers() {
    var s = getData(DB_KEYS.SHOP_CUSTOMERS);
    if (!s || typeof s !== 'object' || Object.prototype.toString.call(s) === '[object Array]') return {};
    return s;
}
function saveShopCustomers(o) { setData(DB_KEYS.SHOP_CUSTOMERS, o); return o; }
/* Only THIS shop's customers. */
function shopCustomers(rid) {
    var all = allShopCustomers();
    var list = all[String(rid)];
    return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
}
function saveShopCustomerList(rid, list) {
    var all = allShopCustomers();
    all[String(rid)] = list;
    return saveShopCustomers(all);
}
function shopNormalisePhone(p) {
    var d = String(p === undefined || p === null ? '' : p).replace(/\D/g, '');
    if (d.charAt(0) === '0') d = '88' + d;
    return d;
}
/* Find a customer in THIS shop only. */
function shopFindCustomer(rid, phone) {
    var want = shopNormalisePhone(phone);
    if (!want) return null;
    var list = shopCustomers(rid);
    for (var i = 0; i < list.length; i++) {
        if (shopNormalisePhone(list[i].phone) === want) return list[i];
    }
    return null;
}
function shopFindCustomerById(rid, id) {
    var list = shopCustomers(rid);
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
}
/* Register against THIS shop. Duplicate phones are rejected per shop, so the
   same person can hold separate accounts in two different shops. */
function shopRegisterCustomer(rid, d) {
    d = d || {};
    var name = String(d.name || '').trim();
    var phone = shopNormalisePhone(d.phone);
    var pass = String(d.password || '');
    if (!name) return { ok: false, message: 'নাম দিন।' };
    if (phone.length < 8) return { ok: false, message: 'সঠিক ফোন নম্বর দিন।' };
    if (pass.length < 4) return { ok: false, message: 'পাসওয়ার্ড অন্তত ৪ অক্ষরের হতে হবে।' };
    if (shopFindCustomer(rid, phone)) return { ok: false, message: 'এই নম্বরে ইতিমধ্যে একাউন্ট আছে। লগিন করুন।' };
    var list = shopCustomers(rid);
    var c = {
        id: 'C' + Date.now() + Math.floor(Math.random() * 1000),
        shopId: String(rid),                 /* ownership lives on the record */
        name: name, phone: phone, password: pass,
        email: String(d.email || '').trim(),
        address: String(d.address || '').trim(),
        createdAt: new Date().toISOString(),
        lastLoginAt: ''
    };
    list.push(c);
    saveShopCustomerList(rid, list);
    /* 2026-09-18 — also remember them in this shop's Customer Information, so the
       reseller never has to retype their name / number / address next time. */
    try { ciRemember(rid, { name: name, phone: phone, address: c.address }, 'register'); } catch (e) { }
    return { ok: true, customer: c };
}
function shopLoginCustomer(rid, phone, password) {
    var c = shopFindCustomer(rid, phone);
    if (!c) return { ok: false, message: 'এই নম্বরে কোনো একাউন্ট নেই।' };
    if (String(c.password) !== String(password || '')) return { ok: false, message: 'পাসওয়ার্ড ভুল হয়েছে।' };
    var list = shopCustomers(rid);
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(c.id)) list[i].lastLoginAt = new Date().toISOString();
    }
    saveShopCustomerList(rid, list);
    /* 2026-09-18 — a login is a fresh set of details; remember them */
    try { ciRemember(rid, { name: c.name, phone: c.phone, address: c.address }, 'login'); } catch (e) { }
    return { ok: true, customer: c };
}
/* Session is also scoped per shop, so being logged into one shop never logs
   you into another. */
function shopCustomerSessionKey(rid) { return 'rh_shop_cust_' + String(rid); }
/* #12 — the session lives in localStorage so a customer stays logged in after
   closing the browser, until they log out. It is still keyed PER SHOP, so
   being logged into one shop never logs them into another (#14). */
function shopCurrentCustomer(rid) {
    try {
        var raw = localStorage.getItem(shopCustomerSessionKey(rid));
        if (!raw) return null;
        var s = JSON.parse(raw);
        if (!s || !s.id) return null;
        /* re-verify against the shop's own bucket — never trust the session */
        var c = shopFindCustomerById(rid, s.id);
        /* 2026-09-18 — the customer's presence heartbeat. Every storefront page
           calls this, so a signed-in customer who is actually browsing shows as
           online on the reseller's / admin's customer profile. It writes at most
           once a minute (see shopTouchPresence). */
        if (c) shopTouchPresence(rid, c.id);
        return c;
    } catch (e) { return null; }
}
function shopSetCurrentCustomer(rid, c) {
    try {
        if (!c) localStorage.removeItem(shopCustomerSessionKey(rid));
        else localStorage.setItem(shopCustomerSessionKey(rid), JSON.stringify({ id: String(c.id), shopId: String(rid) }));
    } catch (e) {}
}
function shopLogoutCustomer(rid) { shopSetCurrentCustomer(rid, null); }
function shopUpdateCustomer(rid, id, patch) {
    var list = shopCustomers(rid), hit = null;
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) {
            var allowed = ['name', 'phone', 'email', 'address', 'password'];
            for (var k = 0; k < allowed.length; k++) {
                var key = allowed[k];
                if (patch[key] === undefined) continue;
                if (key === 'phone') list[i].phone = shopNormalisePhone(patch.phone);
                else list[i][key] = String(patch[key]);
            }
            hit = list[i];
            break;
        }
    }
    if (!hit) return { ok: false, message: 'একাউন্ট পাওয়া যায়নি।' };
    saveShopCustomerList(rid, list);
    return { ok: true, customer: hit };
}
/* Orders of THIS shop belonging to THIS customer. Both sides are checked:
   the order must belong to the shop AND match the customer's phone. */
function shopCustomerOrders(rid, cust) {
    if (!cust) return [];
    var want = shopNormalisePhone(cust.phone);
    if (!want) return [];
    var all = asArray(getData(DB_KEYS.ORDERS)), out = [];
    for (var i = 0; i < all.length; i++) {
        var o = all[i];
        if (!o) continue;
        if (!isMyShopOrder(o)) continue;                       /* storefront orders only */
        if (!orderBelongsToReseller(o, rid)) continue;         /* THIS shop only */
        if (shopNormalisePhone(o.phone) !== want) continue;    /* THIS customer only */
        out.push(o);
    }
    out.sort(function (a, b) { return orderTimeMs(b) - orderTimeMs(a); });
    return out;
}
/* A single order, only if it belongs to this shop AND this customer. */
function shopCustomerOrder(rid, cust, orderId) {
    var list = shopCustomerOrders(rid, cust);
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(orderId)) return list[i];
    }
    return null;
}

/* ==========================================================================
   CUSTOMER INFORMATION  (2026-09-18, this request)
   --------------------------------------------------------------------------
   A per-reseller address book that fills itself in. Whenever a customer's
   details arrive they are remembered here, so the NEXT order is one click
   instead of retyping a name, a number and an address.

   WHERE THE DETAILS COME FROM — all automatic, nothing for anyone to press:
     · My Shop — register, login, placing an order, or a guest chat message
     · the reseller's own panel — placing an order from Add New Order
   ciRemember() is the ONE writer, called from each of those points.

   THE PHONE NUMBER IS THE IDENTITY.
     One number = one record. The same number coming back UPDATES that record
     (name / address refreshed from whatever was given last) instead of adding a
     second row, so the list never fills up with duplicates. A number that never
     logs in and never orders is never saved at all.

   TENANT ISOLATION — the whole point of the feature.
     Stored as { "<rid>": [ ... ] } and read ONLY through ciList(rid), the same
     model as rh_shop_customers / rh_shop_chats: a customer who ordered from one
     shop can never appear in another shop's list. ciAllFlat() is the single
     reader that crosses shops and it exists ONLY for the admin page.
   ========================================================================== */
var CI_MAX = 500;                  /* per shop — a contact book, not a log */
/* Which group a capture belongs to. A customer can be in BOTH — someone who
   registered and later ordered is not one or the other, they are both. */
var CI_MYSHOP_SRC = { register: 1, login: 1, chat: 1 };
var CI_ORDER_SRC = { 'myshop-order': 1, 'panel-order': 1 };
function ciAll() {
    var all = getData(DB_KEYS.CUSTOMER_INFO);
    if (Object.prototype.toString.call(all) === '[object Array]') return {};
    return (all && typeof all === 'object') ? all : {};
}
function ciList(rid) {
    var all = ciAll();
    var list = all[String(rid)];
    if (Object.prototype.toString.call(list) !== '[object Array]') return [];
    /* newest activity first — the customer just dealt with is at the top */
    return list.slice().sort(function (a, b) {
        return String((b && b.updatedAt) || '') < String((a && a.updatedAt) || '') ? -1 : 1;
    });
}
function ciSaveList(rid, list) {
    var all = ciAll();
    all[String(rid)] = asArray(list).slice(0, CI_MAX);
    return setData(DB_KEYS.CUSTOMER_INFO, all) !== false;
}
/* The ONE writer. `d` = { name, phone, address }, `source` = a short tag.
   Returns the stored record, or null when there is no usable phone number —
   without a number two people cannot be told apart, so we do not guess. */
function ciRemember(rid, d, source) {
    try {
        if (rid === undefined || rid === null || rid === '') return null;
        d = d || {};
        var phone = shopNormalisePhone(d.phone);
        if (!phone || phone.length < 8) return null;
        var name = String(d.name || '').trim();
        var addr = String(d.address || '').trim();
        /* 2026-09-18 (this request) — the DISTRICT and THANA are part of what a
           reseller has to retype on every order, so they are remembered too. They
           are stored separately from the street address because the order form
           keeps them in their own dropdowns. */
        var dist = String(d.district || '').trim();
        var thn = String(d.thana || '').trim();
        var list = ciList(rid), hit = null, i;
        for (i = 0; i < list.length; i++) {
            if (shopNormalisePhone(list[i].phone) === phone) { hit = list[i]; break; }
        }
        var now = new Date().toISOString();
        var src = String(source || '');
        if (hit) {
            /* keep what we already know; refresh with whatever was given now */
            if (name) hit.name = name;
            if (addr) hit.address = addr;
            if (dist) hit.district = dist;
            if (thn) hit.thana = thn;
            hit.source = src || hit.source || '';
            /* remember BOTH facts about this person, not just the latest one: a
               customer who registered AND later ordered must appear in both
               groups, not vanish from the first one. */
            if (CI_MYSHOP_SRC[src]) hit.myshop = true;
            if (CI_ORDER_SRC[src]) hit.ordered = true;
            /* 2026-09-19 — and BOTH facts about ordering, for the same reason.
               `source` only ever holds the LAST place we saw somebody, so a
               customer who ordered from the shop and was later captured from a
               panel order LOST the shop-order fact and vanished from the My Shop
               Orders group. A flag is set once and never cleared. */
            if (src === 'myshop-order') hit.shopOrdered = true;
            hit.updatedAt = now;
        } else {
            hit = {
                id: 'CI' + Date.now() + Math.floor(Math.random() * 1000),
                name: name, phone: phone, address: addr,
                district: dist, thana: thn,
                source: src, createdAt: now, updatedAt: now,
                myshop: !!CI_MYSHOP_SRC[src], ordered: !!CI_ORDER_SRC[src],
                shopOrdered: (src === 'myshop-order')
            };
            list.unshift(hit);
        }
        if (ciSaveList(rid, list) === false) return null;
        return hit;
    } catch (e) { return null; }
}
function ciFind(rid, id) {
    var list = ciList(rid);
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
}
/* Edit — the reseller corrects a name, a number or an address.
   A number that already belongs to ANOTHER record is refused, or two rows would
   claim the same identity and the automatic de-duplication would break. */
function ciUpdate(rid, id, patch) {
    var list = ciList(rid), hit = null, i;
    for (i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) { hit = list[i]; break; }
    if (!hit) return { ok: false, message: 'কাস্টমারটি পাওয়া যায়নি।' };
    patch = patch || {};
    var phone = (patch.phone === undefined) ? hit.phone : shopNormalisePhone(patch.phone);
    if (!phone || phone.length < 8) return { ok: false, message: 'সঠিক ফোন নম্বর দিন।' };
    for (i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) continue;
        if (shopNormalisePhone(list[i].phone) === phone) {
            return { ok: false, message: 'এই নম্বরটি ইতিমধ্যে অন্য একজন কাস্টমারের।' };
        }
    }
    if (patch.name !== undefined) hit.name = String(patch.name || '').trim();
    if (patch.address !== undefined) hit.address = String(patch.address || '').trim();
    /* 2026-09-18 (this request) — the district / thana are editable too, so a
       reseller can correct them without opening the order form. */
    if (patch.district !== undefined) hit.district = String(patch.district || '').trim();
    if (patch.thana !== undefined) hit.thana = String(patch.thana || '').trim();
    hit.phone = phone;
    hit.updatedAt = new Date().toISOString();
    if (ciSaveList(rid, list) === false) return { ok: false, message: 'সেভ করা যায়নি — storage পূর্ণ।' };
    return { ok: true, customer: hit };
}
function ciRemove(rid, id) {
    var list = ciList(rid), out = [], i, found = false;
    for (i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) { found = true; continue; }
        out.push(list[i]);
    }
    if (!found) return false;
    return ciSaveList(rid, out) !== false;
}
/* Search by NAME or PHONE — the two things a reseller actually knows when the
   customer calls. Address is deliberately not searched. */
function ciSearch(rid, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return ciList(rid);
    var digits = q.replace(/\D/g, '');
    var list = ciList(rid), out = [];
    for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (String(c.name || '').toLowerCase().indexOf(q) !== -1) { out.push(c); continue; }
        if (digits && String(c.phone || '').indexOf(digits) !== -1) { out.push(c); continue; }
    }
    return out;
}
/* The TWO groups the page shows SEPARATELY (this request):
     · My Shop customers — registered, logged in or messaged the shop
     · Order customers   — an order was placed, from My Shop or from the panel
   Each reader falls back to the record's `source`, so a customer saved before the
   flags existed is still classified correctly. A person who did both appears in
   BOTH lists — that is the point of keeping the two facts rather than one. */
function ciMyShopCustomers(rid) {
    return ciList(rid).filter(function (c) {
        return !!(c && (c.myshop || CI_MYSHOP_SRC[String(c.source || '')]));
    });
}
function ciOrderCustomers(rid) {
    return ciList(rid).filter(function (c) {
        return !!(c && (c.ordered || CI_ORDER_SRC[String(c.source || '')]));
    });
}
/* ===========================================================================
   THE FULL CUSTOMER PROFILE  (2026-09-18, this request)
   ---------------------------------------------------------------------------
   Everything known about ONE customer, assembled in the DATA layer so the
   reseller's page and the admin's page can never disagree about the same person.

     rid = a reseller id  -> only THAT shop's orders and account
     rid = null           -> every shop's            (the admin's view)

   Matched on the normalised phone number — that is the identity everywhere else.
   =========================================================================== */
var CI_ONLINE_MS = 5 * 60 * 1000;        /* "online" = seen in the last 5 minutes */

/* Presence heartbeat. A signed-in customer browsing the shop stamps lastSeenAt on
   their own account record; the profile then reads "online" from it. Written at
   most once a minute, so a page refresh loop cannot churn localStorage. */
function shopTouchPresence(rid, customerId) {
    try {
        if (rid === undefined || rid === null || rid === '' || !customerId) return;
        var list = shopCustomers(rid), hit = null, i;
        for (i = 0; i < list.length; i++) if (String(list[i].id) === String(customerId)) { hit = list[i]; break; }
        if (!hit) return;
        var now = Date.now();
        var last = Date.parse(hit.lastSeenAt || '') || 0;
        if (now - last < 60000) return;
        hit.lastSeenAt = new Date(now).toISOString();
        saveShopCustomerList(rid, list);
    } catch (e) { }
}
function shopCustomerIsOnline(rid, phone) {
    try {
        var c = shopFindCustomer(rid, shopNormalisePhone(phone));
        if (!c) return false;
        var seen = Date.parse(c.lastSeenAt || '') || 0;
        return !!seen && (Date.now() - seen) < CI_ONLINE_MS;
    } catch (e) { return false; }
}

function customerProfile(rid, phone, ciRec) {
    var out = {
        record: ciRec || null, phone: shopNormalisePhone(phone), account: null,
        orders: [], orderCount: 0, productCount: 0, totalSpent: 0,
        firstOrder: '', lastOrder: '', joined: '', lastSeenAt: '', online: false,
        shops: [], source: ''
    };
    try {
        var p = out.phone;
        if (!p) return out;
        var all = (rid === null || rid === undefined);

        /* ---- the My Shop account, when they have one ---- */
        var sc = getData(DB_KEYS.SHOP_CUSTOMERS);
        if (sc && typeof sc === 'object' && Object.prototype.toString.call(sc) !== '[object Array]') {
            var rids = all ? Object.keys(sc) : [String(rid)];
            for (var r = 0; r < rids.length; r++) {
                var arr = sc[rids[r]];
                if (Object.prototype.toString.call(arr) !== '[object Array]') continue;
                for (var a = 0; a < arr.length; a++) {
                    if (!arr[a] || shopNormalisePhone(arr[a].phone) !== p) continue;
                    if (out.shops.indexOf(String(rids[r])) === -1) out.shops.push(String(rids[r]));
                    if (!out.account) out.account = arr[a];
                    var cj = String(arr[a].createdAt || '');
                    if (cj && (!out.joined || cj < out.joined)) out.joined = cj;
                    var ls = String(arr[a].lastSeenAt || '');
                    if (ls && ls > out.lastSeenAt) out.lastSeenAt = ls;
                    var ll = String(arr[a].lastLoginAt || '');
                    if (ll && ll > out.lastSeenAt) out.lastSeenAt = ll;
                }
            }
        }

        /* ---- their orders ---- */
        var orders = asArray(getData(DB_KEYS.ORDERS));
        for (var o = 0; o < orders.length; o++) {
            var od = orders[o];
            if (!od || shopNormalisePhone(od.phone) !== p) continue;
            if (!all && String(od.resellerId) !== String(rid)) continue;
            out.orders.push(od);
            out.orderCount++;
            out.totalSpent += Number(od.amount) || 0;
            var q = Number(od.qty) || 0;
            if (!q && od.items && od.items.length) {
                for (var it = 0; it < od.items.length; it++) q += Number(od.items[it].qty) || 0;
            }
            out.productCount += q;
            var d = String(od.date || '');
            if (d && (!out.firstOrder || d < out.firstOrder)) out.firstOrder = d;
            if (d > out.lastOrder) out.lastOrder = d;
        }
        out.orders.sort(function (x, y) { return String(y.date || '') < String(x.date || '') ? -1 : 1; });

        /* ---- joined: the earliest fact we hold about them ---- */
        if (!out.joined && out.record && out.record.createdAt) out.joined = String(out.record.createdAt);
        if (!out.joined && out.firstOrder) out.joined = out.firstOrder;
        if (!out.lastSeenAt && out.record && out.record.updatedAt) out.lastSeenAt = String(out.record.updatedAt);
        out.source = String((out.record && out.record.source) || '');

        var seen = Date.parse(out.lastSeenAt || '') || 0;
        out.online = !!seen && (Date.now() - seen) < CI_ONLINE_MS;
    } catch (e) { }
    return out;
}

/* The ONE renderer for that profile, so the reseller's page and the admin's page
   show the same facts in the same order. */
function customerProfileHtml(prof, opts) {
    opts = opts || {};
    var esc2 = function (s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };
    var money = function (n) {
        try { return formatCurrency(Number(n) || 0); } catch (e) { return '৳' + (Number(n) || 0); }
    };
    var dt = function (s) {
        if (!s) return '—';
        try { return formatDate(s); } catch (e) { return String(s).slice(0, 10); }
    };
    var SRC = {
        register: 'My Shop রেজিস্ট্রেশন', login: 'My Shop লগইন', chat: 'My Shop মেসেজ',
        'myshop-order': 'My Shop অর্ডার', 'panel-order': 'প্যানেল অর্ডার'
    };
    var r = prof.record || {};
    var h = '';

    /* who they are */
    h += '<div class="cp-id">' +
         '<div class="cp-av">' + (r.name ? esc2(String(r.name).charAt(0).toUpperCase()) : '<i class="fas fa-user"></i>') + '</div>' +
         '<div class="cp-who"><b>' + (esc2(r.name) || '(নাম নেই)') + '</b>' +
         '<div class="cp-ph"><i class="fas fa-phone"></i> ' + esc2(prof.phone || r.phone) + '</div>' +
         '<div class="cp-tags">' +
           (prof.online ? '<span class="cp-tag on"><i class="fas fa-circle"></i> এখন অনলাইন</span>'
                        : '<span class="cp-tag off"><i class="far fa-circle"></i> অফলাইন</span>') +
           (SRC[prof.source] ? '<span class="cp-tag">' + esc2(SRC[prof.source]) + '</span>' : '') +
           (prof.account ? '<span class="cp-tag acc"><i class="fas fa-user-check"></i> My Shop একাউন্ট</span>' : '') +
         '</div></div></div>';

    /* the address, in full */
    var addr = [];
    if (r.address) addr.push(esc2(r.address));
    var dtl = [r.thana, r.district].filter(Boolean).map(esc2).join(', ');
    if (dtl) addr.push(dtl);
    h += '<div class="cp-sec"><h5><i class="fas fa-location-dot"></i> ঠিকানা</h5>' +
         '<div class="cp-addr">' + (addr.length ? addr.join('<br>') : '<span class="cp-none">দেওয়া হয়নি</span>') + '</div></div>';

    /* the numbers */
    h += '<div class="cp-stats">' +
         '<div class="cp-stat"><span class="v">' + prof.orderCount + '</span><span class="l">অর্ডার</span></div>' +
         '<div class="cp-stat"><span class="v">' + prof.productCount + '</span><span class="l">প্রোডাক্ট</span></div>' +
         '<div class="cp-stat"><span class="v">' + money(prof.totalSpent) + '</span><span class="l">মোট কিনেছেন</span></div>' +
         '</div>';

    /* the dates */
    h += '<div class="cp-sec"><h5><i class="fas fa-clock-rotate-left"></i> সময়</h5><div class="cp-dates">' +
         '<div><span>যোগ দিয়েছেন</span><b>' + esc2(dt(prof.joined)) + '</b></div>' +
         '<div><span>প্রথম অর্ডার</span><b>' + esc2(dt(prof.firstOrder)) + '</b></div>' +
         '<div><span>শেষ অর্ডার</span><b>' + esc2(dt(prof.lastOrder)) + '</b></div>' +
         '<div><span>সর্বশেষ দেখা</span><b>' + esc2(dt(prof.lastSeenAt)) + '</b></div>' +
         '</div></div>';

    /* the orders themselves */
    h += '<div class="cp-sec"><h5><i class="fas fa-bag-shopping"></i> অর্ডারের তালিকা (' + prof.orderCount + ')</h5>';
    if (!prof.orders.length) {
        h += '<div class="cp-none">এখনো কোনো অর্ডার নেই।</div>';
    } else {
        h += '<div class="cp-orders">';
        for (var i = 0; i < prof.orders.length; i++) {
            var od = prof.orders[i];
            var items = od.items || [];
            var names = [];
            for (var k = 0; k < items.length && k < 3; k++) {
                names.push(esc2(items[k].name) + (Number(items[k].qty) > 1 ? ' ×' + items[k].qty : ''));
            }
            if (items.length > 3) names.push('+' + (items.length - 3) + ' আরও');
            if (!names.length && od.productName) names.push(esc2(od.productName));
            var st = String(od.status || '').replace(/_/g, ' ');
            h += '<div class="cp-ord">' +
                 '<div class="cp-ord-h"><b>' + esc2(od.id) + '</b><span>' + esc2(dt(od.date)) + '</span></div>' +
                 '<div class="cp-ord-i">' + (names.join(', ') || '—') + '</div>' +
                 '<div class="cp-ord-f"><span class="st ' + esc2(String(od.status || '')) + '">' + esc2(st || '—') + '</span>' +
                 '<b>' + money(od.amount) + '</b></div>' +
                 '</div>';
        }
        h += '</div>';
    }
    h += '</div>';

    if (opts.showShop && prof.shops && prof.shops.length) {
        h += '<div class="cp-sec"><h5><i class="fas fa-store"></i> শপ</h5><div class="cp-addr">' +
             prof.shops.map(function (s) { return '#' + esc2(s); }).join(', ') + '</div></div>';
    }
    return h;
}
/* ===========================================================================
   WHAT MAKES UP A WITHDRAWAL  (2026-09-18, this request)
   ---------------------------------------------------------------------------
   "এই টাকাটার কুচকি" — which earnings actually paid for THIS withdrawal.

   Method. adminLedger() already brings every credit and debit of every party into
   one list, so this walks that owner's entries OLDEST FIRST and lets each
   withdrawal consume the credits that were available to it and had NOT already
   been consumed by an EARLIER withdrawal (FIFO). That is the only honest answer
   to "which orders paid for this one" — once money lands in a balance it is
   fungible, so nothing in the data says "this rupee came from order #7"; the
   allocation is what makes it explainable.

   party: 'reseller' | 'supplier'      ownerId: that party's id
   wdId:  the withdrawal / payout record id
   =========================================================================== */
function withdrawalBreakdown(party, ownerId, wdId) {
    var out = { found: false, withdrawal: null, contributions: [], deductions: [],
                total: 0, earnedIn: 0, spentIn: 0, party: party, ownerId: ownerId };
    try {
        var ledger = (typeof adminLedger === 'function') ? adminLedger() : [];
        var mine = [], i;
        for (i = 0; i < ledger.length; i++) {
            var e = ledger[i];
            if (!e || String(e.party) !== String(party)) continue;
            if (String(e.partyId) !== String(ownerId)) continue;
            mine.push(e);
        }
        /* adminLedger() returns newest-first; the allocation must run oldest-first */
        mine.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });

        var isWd = function (x) { return x.source === 'withdrawals' || x.source === 'payouts' || x.type === 'withdrawal' || x.type === 'payout'; };
        var wd = null;
        for (i = 0; i < mine.length; i++) {
            if (isWd(mine[i]) && String(mine[i].ref) === String(wdId)) { wd = mine[i]; break; }
        }
        if (!wd) return out;
        out.found = true;
        out.withdrawal = wd;

        /* ---- the FIFO walk ---- */
        var pool = [];                 /* available credits: { e, left } */
        var windowStart = 0;           /* ts of the previous withdrawal */
        var takenForWd = null;
        for (i = 0; i < mine.length; i++) {
            var m = mine[i];
            var amt = Number(m.amount) || 0;
            if (m.direction === 'credit') { pool.push({ e: m, left: amt }); }
            else {
                /* a debit consumes from the pool, oldest credit first */
                var need = amt, taken = [];
                for (var p = 0; p < pool.length && need > 0; p++) {
                    if (pool[p].left <= 0) continue;
                    var use = Math.min(pool[p].left, need);
                    pool[p].left -= use;
                    need -= use;
                    taken.push({ e: pool[p].e, amount: use });
                }
                if (isWd(m)) {
                    if (m === wd) { takenForWd = taken; out.deductions = out.deductions; }
                    /* the window for the NEXT withdrawal starts here */
                    if (m === wd) { /* stop collecting once we have our own */ }
                    windowStart = m.ts || 0;
                } else if (m.ts >= windowStart && !takenForWd) {
                    /* a non-withdrawal debit (a return charge, a fine) that falls in
                       this withdrawal's window — it is part of why the amount is
                       what it is, so it is shown too */
                    out.deductions.push(m);
                }
            }
            if (m === wd) break;
        }
        out.contributions = takenForWd || [];

        /* the credits this withdrawal actually drew on */
        for (i = 0; i < out.contributions.length; i++) out.total += Number(out.contributions[i].amount) || 0;
        /* how much was earned in the same window (the period's income) */
        var floor = 0;
        for (i = 0; i < out.contributions.length; i++) {
            var c = out.contributions[i];
            if (c.e.source === 'orders' || c.e.source === 'transactions') out.earnedIn += c.amount;
        }
        out.spentIn = out.deductions.reduce(function (s, d) { return s + (Number(d.amount) || 0); }, 0);
    } catch (e) { }
    return out;
}

/* The ONE renderer for that breakdown — used by the reseller's page, the admin's
   reseller-withdrawals page and the admin's supplier-withdrawals page, so all
   three explain the same money the same way. */
function withdrawalBreakdownHtml(bd) {
    var esc2 = function (s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };
    var money = function (n) {
        try { return formatCurrency(Number(n) || 0); } catch (e) { return '৳' + (Number(n) || 0); }
    };
    var dt = function (s) { if (!s) return '—'; try { return formatDate(s); } catch (e) { return String(s).slice(0, 10); } };

    var ICON = {
        orders:         ['fa-box', 'অর্ডার ডেলিভারি থেকে', 'ord'],
        transactions:   ['fa-sack-dollar', 'প্রফিট / আর্নিং', 'ord'],
        payouts:        ['fa-money-bill-transfer', 'পেআউট', 'wd'],
        withdrawals:    ['fa-money-bill-transfer', 'উইথড্রয়াল', 'wd'],
        admin:          ['fa-user-shield', 'অ্যাডমিন', 'adm'],
        system:         ['fa-circle-info', 'সিস্টেম', 'sys']
    };
    var LABEL = {
        order_profit: 'অর্ডার প্রফিট', referral: 'রেফারেল কমিশন', offer_reward: 'অফার রিওয়ার্ড',
        failed_delivery: 'ফেইল ডেলিভারি চার্জ', admin: 'অ্যাডমিন', order_delivery: 'ডেলিভারি থেকে আয়',
        adjustment: 'অ্যাডমিন সমন্বয়', payout: 'পেআউট', withdrawal: 'উইথড্রয়াল', system: 'সিস্টেম'
    };
    /* adminLedger() puts the KIND of entry in `source` for a wallet transaction
       (order_profit / referral / …) and in `type` for a derived one
       (order_delivery / payout). Look in both, and never fall back to the bare
       'credit'/'debit' that `type` carries for a transaction. */
    var labelOf = function (e) {
        var s = String(e.source || ''), t = String(e.type || '');
        return LABEL[s] || LABEL[t] || e.label || t || 'আর্নিং';
    };
    var wd = bd.withdrawal || {};
    var h = '';

    /* the withdrawal itself */
    h += '<div class="wb-head">' +
         '<div class="wb-amt">' + money(wd.amount) + '</div>' +
         '<div class="wb-sub">' + esc2(wd.label || 'উইথড্রয়াল') + ' · ' + esc2(dt(wd.date)) +
         (wd.status ? ' · <span class="wb-st ' + esc2(String(wd.status)) + '">' + esc2(String(wd.status)) + '</span>' : '') +
         '</div>' +
         (wd.note ? '<div class="wb-note">' + esc2(wd.note) + '</div>' : '') +
         '</div>';

    /* the income that funded it */
    h += '<div class="wb-sec"><h5><i class="fas fa-arrow-down"></i> এই টাকা যেখান থেকে এসেছে (' +
         bd.contributions.length + ')</h5>';
    if (!bd.contributions.length) {
        h += '<div class="wb-none">এই উইথড্রয়ালটা কোনো আর্নিং থেকে ধরা হয়নি — ব্যালেন্সে আগে থেকেই টাকা ছিল।</div>';
    } else {
        h += '<div class="wb-list">';
        for (var i = 0; i < bd.contributions.length; i++) {
            var c = bd.contributions[i], e = c.e || {};
            var ic = ICON[e.source] || ICON.system;
            var lab = labelOf(e);
            h += '<div class="wb-item">' +
                 '<span class="wb-ic ' + ic[2] + '"><i class="fas ' + ic[0] + '"></i></span>' +
                 '<span class="wb-mid"><b>' + esc2(lab) + '</b>' +
                 '<small>' + esc2(e.note || '') + (e.note ? ' · ' : '') + esc2(dt(e.date)) + '</small></span>' +
                 '<span class="wb-v">' + money(c.amount) + '</span>' +
                 '</div>';
        }
        h += '</div>';
        h += '<div class="wb-total"><span>মোট ইনকাম থেকে ধরা হয়েছে</span><b>' + money(bd.total) + '</b></div>';
    }
    h += '</div>';

    /* what was taken out in the same period */
    if (bd.deductions.length) {
        h += '<div class="wb-sec"><h5><i class="fas fa-arrow-up"></i> এই সময়ে যা কাটা হয়েছে (' +
             bd.deductions.length + ')</h5><div class="wb-list">';
        for (var j = 0; j < bd.deductions.length; j++) {
            var d = bd.deductions[j];
            var lab2 = labelOf(d);
            h += '<div class="wb-item">' +
                 '<span class="wb-ic bad"><i class="fas fa-minus"></i></span>' +
                 '<span class="wb-mid"><b>' + esc2(lab2) + '</b>' +
                 '<small>' + esc2(d.note || '') + (d.note ? ' · ' : '') + esc2(dt(d.date)) + '</small></span>' +
                 '<span class="wb-v minus">−' + money(d.amount) + '</span>' +
                 '</div>';
        }
        h += '</div><div class="wb-total"><span>মোট কাটা হয়েছে</span><b class="minus">−' + money(bd.spentIn) + '</b></div></div>';
    }

    return h;
}
/* ===========================================================================
   THE ORDERS THAT CAME FROM THE SHOP  (2026-09-18, this request)
   ---------------------------------------------------------------------------
   A customer ordering from My Shop is a different event from the reseller typing
   an order in the panel, so it gets its own list rather than being mixed in.

   REAL records only — read straight from rh_orders, filtered on the same
   `source` / `order_source` = 'myshop' that my-shop-checkout.html writes. Nothing
   here is derived, seeded or invented: if the shop has had no orders, this is
   empty and says so.
   =========================================================================== */
function ciIsShopOrder(o) {
    if (!o) return false;
    return String(o.source || '') === 'myshop' || String(o.order_source || '') === 'myshop';
}
function ciShopOrders(rid) {
    var out = [];
    try {
        var orders = asArray(getData(DB_KEYS.ORDERS));
        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            if (!ciIsShopOrder(o)) continue;
            if (rid !== null && rid !== undefined && String(o.resellerId) !== String(rid)) continue;
            out.push(o);
        }
        out.sort(function (a, b) { return String(b.date || '') < String(a.date || '') ? -1 : 1; });
    } catch (e) { }
    return out;
}
/* ===========================================================================
   RESERVE / REFUND THE MONEY OF A WITHDRAWAL  (2026-09-19, this request)
   ---------------------------------------------------------------------------
   THE AMOUNT LEAVES THE BALANCE THE MOMENT THE REQUEST IS RAISED, not when an
   admin gets round to approving it. Until now the balance only moved on APPROVE,
   so a pending request could be spent twice over — the reseller could raise a
   request and then spend the same money on orders, and the admin would later
   either pay out money the business no longer held or have to refuse it.

   Both halves live here, in the data layer, so the reseller's page, the supplier
   panel and the admin's page all move money through the same code:

     withdrawalReserve(kind, ownerId, amount, ref, note)  — request time: deduct
     withdrawalRefund (kind, ownerId, amount, ref, note)  — reject time:  give back

   A reserve writes a `withdraw` DEBIT and a refund writes a `withdraw_refund`
   CREDIT, so the wallet ledger and the withdrawal-breakdown popup stay truthful
   about where the money went and where it came back from.

   `totalWithdraw` is NOT touched here — that counts money actually SENT, so it
   still happens on approve.
   =========================================================================== */
function withdrawalOwnerStore(kind) {
    return (String(kind) === 'supplier') ? DB_KEYS.SUPPLIERS : DB_KEYS.RESELLERS;
}
function withdrawalReserve(kind, ownerId, amount, ref, note) {
    try {
        var amt = Number(amount) || 0;
        if (amt <= 0) return { ok: false, message: 'সঠিক পরিমাণ দিন।' };
        var key = withdrawalOwnerStore(kind);
        var list = asArray(getData(key)), hit = null, i;
        for (i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(ownerId)) { hit = list[i]; break; }
        }
        if (!hit) return { ok: false, message: 'অ্যাকাউন্ট পাওয়া যায়নি।' };
        var bal = Number(hit.balance) || 0;
        if (bal < amt) return { ok: false, message: 'ব্যালেন্স যথেষ্ট নয়।' };
        hit.balance = bal - amt;
        if (setData(key, list) === false) return { ok: false, message: 'সেভ করা যায়নি — storage পূর্ণ।' };

        /* the ledger entry, so the wallet and the breakdown popup both show it */
        try {
            var tx = asArray(getData(DB_KEYS.TRANSACTIONS));
            var t = {
                id: 'TX' + Date.now() + Math.floor(Math.random() * 1000),
                type: 'debit', source: 'withdraw', amount: amt,
                note: String(note || '') || ('Withdrawal requested — ' + ref),
                date: new Date().toISOString()
            };
            if (String(kind) === 'supplier') { t.supplierId = ownerId; t.party = 'supplier'; }
            else { t.resellerId = ownerId; }
            tx.push(t);
            setData(DB_KEYS.TRANSACTIONS, tx);
        } catch (e) { }
        return { ok: true, balance: hit.balance };
    } catch (e) { return { ok: false, message: 'কাটা যায়নি।' }; }
}
function withdrawalRefund(kind, ownerId, amount, ref, note) {
    try {
        var amt = Number(amount) || 0;
        if (amt <= 0) return { ok: false };
        var key = withdrawalOwnerStore(kind);
        var list = asArray(getData(key)), hit = null, i;
        for (i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(ownerId)) { hit = list[i]; break; }
        }
        if (!hit) return { ok: false, message: 'অ্যাকাউন্ট পাওয়া যায়নি।' };
        hit.balance = (Number(hit.balance) || 0) + amt;
        if (setData(key, list) === false) return { ok: false, message: 'সেভ করা যায়নি — storage পূর্ণ।' };

        try {
            var tx = asArray(getData(DB_KEYS.TRANSACTIONS));
            var t = {
                id: 'TX' + Date.now() + Math.floor(Math.random() * 1000),
                type: 'credit', source: 'withdraw_refund', amount: amt,
                note: String(note || '') || ('Withdrawal rejected — money returned (' + ref + ')'),
                date: new Date().toISOString()
            };
            if (String(kind) === 'supplier') { t.supplierId = ownerId; t.party = 'supplier'; }
            else { t.resellerId = ownerId; }
            tx.push(t);
            setData(DB_KEYS.TRANSACTIONS, tx);
        } catch (e) { }
        return { ok: true, balance: hit.balance };
    } catch (e) { return { ok: false, message: 'ফেরত দেওয়া যায়নি।' }; }
}
/* ===========================================================================
   CUSTOMERS WHO ORDERED FROM THE SHOP  (2026-09-19)
   ---------------------------------------------------------------------------
   The people who ordered FROM My Shop — with or without registering — kept as
   CONTACT RECORDS, exactly like the other two groups, so the reseller can place
   their next order in one click instead of retyping a name, a number and an
   address. This is deliberately a CUSTOMER list, not an order list: the orders
   themselves already have their own page (my-shop-orders.html).
   =========================================================================== */
function ciShopOrderCustomers(rid) {
    return ciList(rid).filter(function (c) {
        if (!c) return false;
        /* the FLAG first — it is set once and never cleared. `source` only holds
           the last place we saw them, so relying on it made a customer who later
           appeared in a panel order disappear from this group. */
        if (c.shopOrdered === true) return true;
        return String(c.source || '') === 'myshop-order';   /* records made before the flag existed */
    });
}
/* The ONE reader that crosses shops — for the ADMIN page only. Every row is
   tagged with the owning reseller so the admin can always tell whose it is. */
function ciAllFlat() {
    var all = ciAll(), out = [], rid, i;
    for (rid in all) {
        if (!Object.prototype.hasOwnProperty.call(all, rid)) continue;
        var list = asArray(all[rid]);
        for (i = 0; i < list.length; i++) {
            if (!list[i]) continue;
            out.push({ id: list[i].id, rid: rid, name: list[i].name, phone: list[i].phone,
                       address: list[i].address, source: list[i].source,
                       createdAt: list[i].createdAt, updatedAt: list[i].updatedAt });
        }
    }
    out.sort(function (a, b) { return String(b.updatedAt || '') < String(a.updatedAt || '') ? -1 : 1; });
    return out;
}
/* ---- the "Order" button's bridge to order.html -------------------------
   Handed over through sessionStorage, NOT the URL: an address is long and would
   be truncated in a query string, and a customer's name, number and address do
   not belong in the browser history or in a link someone might share.
   order.html reads it once and clears it, so a refresh does not re-fill. */
var CI_PREFILL_KEY = 'rh_order_prefill';
function ciSetOrderPrefill(rec) {
    try {
        if (!rec) return false;
        sessionStorage.setItem(CI_PREFILL_KEY, JSON.stringify({
            name: String(rec.name || ''), phone: String(rec.phone || ''),
            address: String(rec.address || ''),
            /* 2026-09-18 (this request) — the district and thana go with it, so the
               order form's two dropdowns arrive already chosen. The reseller can
               still change them; they are only a starting point. */
            district: String(rec.district || ''), thana: String(rec.thana || '')
        }));
        return true;
    } catch (e) { return false; }
}
function ciTakeOrderPrefill() {
    try {
        var raw = sessionStorage.getItem(CI_PREFILL_KEY);
        if (!raw) return null;
        sessionStorage.removeItem(CI_PREFILL_KEY);
        var o = JSON.parse(raw);
        return (o && typeof o === 'object') ? o : null;
    } catch (e) { return null; }
}

/* ==========================================================================
   MY SHOP HERO IMAGES  (reseller-uploaded)
   --------------------------------------------------------------------------
   Stored on the EXISTING reseller record, exactly like `shop_logo` — there is
   no second/parallel media system and no new storage key:

       reseller.shop_heroes = [ "<dataURL>", ... ]      max 3

   Why an array on the reseller record and not a new DB key: ownership then
   comes for free from the record the shop already resolves by `rid`. Reseller
   A's heroes can never appear in Reseller B's shop because the reader takes
   `rid` FIRST and reads ONLY that record — the same isolation model as
   `shopChats(rid)` / `shopCustomers(rid)`.

   `shopHeroes(rid)` is the ONE reader used by the storefront. It returns [] for
   an unknown shop and never falls back to another shop's images.
   =========================================================================== */
var SHOP_HERO_MAX = 3;
function shopHeroes(rid) {
    try {
        var r = null;
        /* resolve the shop record the same way the storefront does */
        if (typeof findResellerById === 'function') r = findResellerById(rid);
        if (!r) { r = findResellerById(parseInt(rid, 10)); }
        if (!r) return [];
        var list = r.shop_heroes || r.shopHeroes || [];
        if (Object.prototype.toString.call(list) !== '[object Array]') return [];
        var out = [];
        for (var i = 0; i < list.length && out.length < SHOP_HERO_MAX; i++) {
            var src = (typeof list[i] === 'string') ? list[i] : (list[i] && list[i].src) || '';
            if (src) out.push(String(src));
        }
        return out;
    } catch (e) { return []; }
}
/* Save the hero list for ONE shop. Returns the stored array (already trimmed to
   SHOP_HERO_MAX) or null if the shop could not be found. */
function shopSetHeroes(rid, list) {
    try {
        var rs = asArray(getData(DB_KEYS.RESELLERS));
        var cleaned = [];
        var arr = Object.prototype.toString.call(list) === '[object Array]' ? list : [];
        for (var i = 0; i < arr.length && cleaned.length < SHOP_HERO_MAX; i++) {
            var src = (typeof arr[i] === 'string') ? arr[i] : (arr[i] && arr[i].src) || '';
            if (src) cleaned.push(String(src));
        }
        for (var k = 0; k < rs.length; k++) {
            if (String(rs[k].id) !== String(rid)) continue;
            rs[k].shop_heroes = cleaned;
            rs[k].shopHeroes = cleaned;      /* mirror, so both spellings read back */
            setData(DB_KEYS.RESELLERS, rs);
            return cleaned;
        }
    } catch (e) {}
    return null;
}
function shopAddHero(rid, src) {
    var cur = shopHeroes(rid);
    if (cur.length >= SHOP_HERO_MAX) return { ok: false, message: 'সর্বোচ্চ ' + SHOP_HERO_MAX + 'টি Hero Image দেওয়া যাবে।' };
    cur.push(String(src));
    var saved = shopSetHeroes(rid, cur);
    return saved ? { ok: true, heroes: saved } : { ok: false, message: 'Shop পাওয়া যায়নি।' };
}
function shopRemoveHero(rid, index) {
    var cur = shopHeroes(rid);
    index = parseInt(index, 10);
    if (isNaN(index) || index < 0 || index >= cur.length) return { ok: false, message: 'Image পাওয়া যায়নি।' };
    cur.splice(index, 1);
    var saved = shopSetHeroes(rid, cur);
    return saved ? { ok: true, heroes: saved } : { ok: false, message: 'Shop পাওয়া যায়নি।' };
}

/* ==========================================================================
   CUSTOMER CART SNAPSHOT  (so the reseller can see what is in the cart)
   --------------------------------------------------------------------------
   The storefront cart lives in the CUSTOMER'S OWN browser as
   `rh_mycart_<rid>` — the reseller's browser genuinely cannot read it, and no
   amount of frontend code changes that. So the cart the reseller needs to see
   is the one the CUSTOMER chose to share:

       rh_shop_carts = { "<rid>": { "<normalisedPhone>": { items:[...], at } } }

   The storefront writes this bucket whenever a cart is created/updated (and at
   the moment a message is sent). `shopCustomerCart(rid, cust)` reads ONLY this
   shop's bucket for THIS customer's phone — never another shop, never another
   customer, and never another browser.
   =========================================================================== */
function allShopCarts() {
    var s = getData('rh_shop_carts');
    if (!s || typeof s !== 'object' || Object.prototype.toString.call(s) === '[object Array]') return {};
    return s;
}
function saveAllShopCarts(o) { setData('rh_shop_carts', o); return o; }
/* Publish the CURRENT cart for this shop + phone. Called from the storefront. */
function shopPublishCart(rid, phone, items) {
    var p = shopNormalisePhone(phone);
    if (!p) return false;
    try {
        var all = allShopCarts();
        var bucket = all[String(rid)];
        if (!bucket || typeof bucket !== 'object') bucket = {};
        var clean = [];
        var arr = Object.prototype.toString.call(items) === '[object Array]' ? items : [];
        for (var i = 0; i < arr.length; i++) {
            var it = arr[i]; if (!it) continue;
            clean.push({
                productId: String(it.productId || it.product_id || it.id || ''),
                name: String(it.name || ''),
                image: String(it.image || ''),
                size: String(it.size || ''),
                color: String(it.color || ''),
                qty: Number(it.qty) || 0,
                price: Number(it.resale || it.selling_price || it.price || 0) || 0
            });
        }
        bucket[p] = { items: clean, at: new Date().toISOString() };
        all[String(rid)] = bucket;
        saveAllShopCarts(all);
        return true;
    } catch (e) { return false; }
}
/* Read the shared cart for THIS shop + THIS customer's phone. */
function shopCustomerCart(rid, cust) {
    var p = shopNormalisePhone(cust && cust.phone);
    if (!p) return [];
    try {
        var all = allShopCarts();
        var bucket = all[String(rid)];
        if (!bucket || typeof bucket !== 'object') return [];
        var rec = bucket[p];
        if (!rec) return [];
        var items = rec.items;
        return Object.prototype.toString.call(items) === '[object Array]' ? items : [];
    } catch (e) { return []; }
}

/* ==========================================================================
   MULTI-SUPPLIER ORDERS
   --------------------------------------------------------------------------
   A READ-ONLY, SOURCE-BASED VIEW over the EXISTING order records. Nothing here
   creates, splits, copies or deletes an order — the parent order and its
   order-item relationship are left exactly as they are (#25). Historical rows
   are classified dynamically from the ownership data they already carry (#26),
   so no migration is needed and nothing is overwritten.

   Detection is ITEM LEVEL and backend level: every line is resolved to its
   real supplier using the existing product_source / product_owner_type /
   product_owner_id / supplierId fields. No hardcoded supplier id, no product
   name matching (#24).

   THE RULE (#2, #6, #7): count UNIQUE suppliers.
     - a reseller-owned line is NOT a supplier
     - an admin line is NOT a supplier
     - ten products of the SAME supplier still count as ONE
     2 or more unique suppliers  ->  Multi-Supplier Order
   =========================================================================== */
var MULTI_SUPPLIER_MIN = 2;
/* The supplier id ONE order line belongs to, or '' when the line is NOT a
   supplier line (reseller-owned or admin). */
function orderItemSupplierId(it) {
    if (!it) return '';
    var pid = (it.productId !== undefined && it.productId !== null) ? it.productId : it.product_id;
    var p = findProductById(pid);
    var lineSup = (it.supplierId !== undefined && it.supplierId !== null) ? it.supplierId
                : (it.supplier_id !== undefined && it.supplier_id !== null) ? it.supplier_id : null;
    /* the product record is authoritative when it still exists */
    if (p) {
        var pSup = (p.supplierId !== undefined && p.supplierId !== null) ? p.supplierId
                 : (p.supplier_id !== undefined && p.supplier_id !== null) ? p.supplier_id : null;
        if (pSup !== null && String(pSup) !== '') return String(pSup);
        /* a reseller-owned or admin product is never a supplier line */
        if (productOwnerType(p) === 'reseller') return '';
        if (pSup === null && lineSup !== null) return String(lineSup);
        /* The row exists but carries NO ownership information at all — it has
           lost its supplier link (productOwnerType() returns 'admin' as its
           DEFAULT for "nothing known", so this used to be read as a genuine
           admin product and the line was discarded). Fall back to the line's
           frozen snapshot, exactly as when the row is gone. */
        if (!productHasOwnerInfo(p)) return supplierIdFromLine(it, lineSup);
        return '';
    }
    /* legacy row with no product record — trust the line's own source */
    return supplierIdFromLine(it, lineSup);
}
/* Unique supplier ids of ONE parent order. Quantity is irrelevant: the same
   supplier appearing on ten lines still yields ONE id (#2, #23). */
function orderSupplierIds(o) {
    var items = orderLineItems(o), seen = {}, out = [];
    for (var i = 0; i < items.length; i++) {
        var sid = orderItemSupplierId(items[i]);
        if (!sid) continue;                 /* reseller-owned or admin line */
        if (seen[sid]) continue;
        seen[sid] = 1;
        out.push(sid);
    }
    return out;
}
function orderSupplierCount(o) { return orderSupplierIds(o).length; }
/* THE single source of truth for the whole feature. */
function isMultiSupplierOrder(o) {
    return !!o && orderSupplierCount(o) >= MULTI_SUPPLIER_MIN;
}
/* Every parent order carrying 2+ distinct suppliers (Admin view). */
function multiSupplierOrders() {
    var all = asArray(getData(DB_KEYS.ORDERS)), out = [];
    for (var i = 0; i < all.length; i++) if (isMultiSupplierOrder(all[i])) out.push(all[i]);
    return out;
}
/* #13/#14 — a supplier only ever sees a Multi-Supplier order it actually has a
   line in. Knowing the order id is not enough (#28). */
function multiSupplierOrdersFor(sid) {
    var all = multiSupplierOrders(), out = [];
    for (var i = 0; i < all.length; i++) {
        if (orderAwaitingResellerConfirm(all[i])) continue;   /* reseller has not confirmed yet */
        var items = orderLineItems(all[i]), hit = false;
        for (var j = 0; j < items.length; j++) {
            var s = orderItemSupplierId(items[j]);
            if (s && String(s) === String(sid)) { hit = true; break; }
        }
        if (hit) out.push(all[i]);
    }
    return out;
}
function supplierLabelById(sid) {
    var s = (typeof findSupplierById === 'function') ? findSupplierById(sid) : null;
    return (s && (s.shopName || s.name)) || ('Supplier #' + sid);
}
function resellerLabelById(rid) {
    var r = (typeof findResellerById === 'function') ? findResellerById(rid) : null;
    return (r && (r.businessName || r.name)) || ('Reseller #' + rid);
}
/* #9/#10/#18 — group one parent order's lines by owner:
   Reseller (own) · Admin · one group per supplier, each with product, variant
   and quantity.
   #14/#28 — a SUPPLIER viewer gets full detail for its OWN group only. Other
   suppliers appear by name with just the fulfilment context (line count and
   total qty) — never their product names, prices or internal data. */
function orderSupplierGroups(o, viewerType, viewerId) {
    var items = orderLineItems(o), groups = [], map = {};
    function G(key, label, kind, ownerId) {
        if (map[key]) return map[key];
        var g = { key: key, label: label, kind: kind, ownerId: ownerId || '',
                  items: [], lines: 0, qty: 0, mine: false, hidden: false };
        map[key] = g; groups.push(g); return g;
    }
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        var sid = orderItemSupplierId(it);
        var g;
        if (sid) {
            g = G('s:' + sid, supplierLabelById(sid), 'supplier', sid);
        } else if (orderItemIsResellerOwned(it)) {
            var rid = (it.product_owner_id !== undefined && it.product_owner_id !== null) ? it.product_owner_id
                    : (it.ownerResellerId !== undefined && it.ownerResellerId !== null) ? it.ownerResellerId : '';
            g = G('r:' + rid, resellerLabelById(rid) + ' (Reseller product)', 'reseller', rid);
        } else {
            g = G('admin', 'ResellerHub (Admin Product)', 'admin', '');
        }
        g.lines++;
        g.qty += Number(it.qty) || 1;
        /* Image + the price THIS line sold for. Both live here (the shared data
           layer) rather than in each page, so the admin list, the admin modal and
           the supplier page can never disagree. PRIVACY: these two fields ride on
           the item, and items[] is emptied for every group a supplier may not
           see — so a rival supplier still learns nothing. */
        var itemPid = (it.productId === undefined || it.productId === null) ? '' : String(it.productId);
        var itemP = itemPid ? findProductById(itemPid) : null;
        var itemImg = String(it.image || '');
        if (!itemImg && itemP && typeof productPrimaryImage === 'function') itemImg = String(productPrimaryImage(itemP) || '');
        if (!itemImg && itemP) itemImg = String(itemP.image || '');
        var itemQty = Number(it.qty) || 1;
        var itemPrice = (typeof itemSellingPrice === 'function') ? (Number(itemSellingPrice(it)) || 0) : (Number(it.price) || 0);
        g.items.push({
            index: i,
            productId: itemPid,
            name: String(it.name || it.productName || 'Product'),
            qty: itemQty,
            variant: (typeof msgVariantLabelOf === 'function') ? msgVariantLabelOf(it) : (it.size || it.color || ''),
            image: itemImg,
            price: itemPrice,
            lineTotal: Math.round(itemPrice * itemQty)
        });
    }
    /* mark ownership + apply supplier privacy */
    for (var k = 0; k < groups.length; k++) {
        var gg = groups[k];
        if (String(viewerType) === 'supplier') {
            gg.mine = (gg.kind === 'supplier' && String(gg.ownerId) === String(viewerId));
            /* PRIVACY (spec, 2026-09-14) — a supplier sees ONLY its own lines.
               Rival SUPPLIER groups, the RESELLER group and ADMIN lines are all
               withheld: one supplier must never see another supplier's details,
               nor the reseller's details. Not their names, not their line
               counts, not their prices, not even how many suppliers there are. */
            gg.hidden = !gg.mine;
        } else if (String(viewerType) === 'reseller') {
            gg.mine = (gg.kind === 'reseller' && String(gg.ownerId) === String(viewerId));
            gg.hidden = (gg.kind === 'reseller' && !gg.mine);
        } else {
            gg.mine = false; gg.hidden = false;      /* admin sees everything */
        }
        if (gg.hidden) {
            gg.items = [];                            /* strip private detail */
            /* and the rival's NAME with it — a hidden group must carry no
               identity at all, so a future page cannot leak it by rendering
               `label` without checking `hidden` first. */
            if (String(viewerType) === 'supplier') gg.label = '';
        }
    }
    return groups;
}
/* #15/#16 — a supplier may never ship, dispatch or mark a Multi-Supplier order
   ready: the platform collects it. Enforced here so a UI bypass cannot cheat. */
function supplierMayShipOrder(o) {
    if (!o) return false;
    return !isMultiSupplierOrder(o);
}
var MULTI_SUPPLIER_NOTICE =
    'This is a Multi-Supplier Order. This order will be collected from the suppliers by ResellerHub BD / authorized platform representative.';

/* ==========================================================================
   MULTI-SUPPLIER — SHARED ADMIN ACTIONS (2026-09-14)
   --------------------------------------------------------------------------
   Three pieces used by BOTH the admin and the supplier Multi-Supplier pages,
   so the two panels can never disagree:
     1. ORDER STAGES      — one vocabulary for "which stage is the parcel at".
     2. PRODUCT SUMMARY   — the product-wise ORDER SUMMARY, factored out of the
                            Admin All Orders page so the Multi-Supplier pages
                            render the SAME view instead of a lookalike.
     3. SUPPLIER INVOICES — one invoice per supplier (2 suppliers -> 2, 3 -> 3),
                            reusing the existing print stylesheet.
   ========================================================================== */

/* ---------- 1. order stages ---------- */
/* The fulfilment pipeline, in order. `new` and `pending` are the same step for
   progress purposes (both mean "not confirmed yet"); the two legacy status
   words map onto their modern equivalents. A status outside this list
   (returned / wfr / cancel) is OFF the pipeline and is shown as itself. */
var ORDER_STAGES = [
    { k: 'new', l: 'New' },
    { k: 'confirmed', l: 'Confirmed' },
    { k: 'packaging', l: 'Packaging' },
    { k: 'handed_to_courier', l: 'Handed to Courier' },
    { k: 'shipping', l: 'Shipping' },
    { k: 'in_transit', l: 'In Transit' },
    { k: 'delivered', l: 'Delivered' }
];
var ORDER_STAGE_ALIAS = { 'processing': 'new', 'pending': 'new', 'shipped': 'shipping' };
var ORDER_STAGE_OFF = { 'returned': 1, 'wfr': 1, 'cancel': 1, 'cancelled': 1,
    'failed_delivery': 1,
    'failed_delivery_product_coming': 1, 'failed_delivery_product_delivered': 1,
    'return_product_coming': 1, 'return_product_delivered': 1 };

/* ==========================================================================
   FAILED DELIVERY / RETURN CHARGES  (2026-09-15)
   The RESELLER pays, automatically, the moment an order fails:
       Inside Dhaka  : 70 delivery + 10 packaging  = 80
       Outside Dhaka : 120 delivery + 10 packaging = 130
   One set of numbers for the whole app so admin All Orders, the multi-supplier
   page and any future surface can never disagree.
   ========================================================================== */
var FEE_DELIVERY_INSIDE = 70;
var FEE_DELIVERY_OUTSIDE = 120;
/* 2026-09-18 (this request) — a Dhaka Sub-Urban order is its own tier, so a
   failed delivery there is neither the inside nor the outside fee. The user set
   it to ৳100, matching the ৳100 the customer pays for Sub-Urban delivery.
   NOTE the existing shape: this constant is the DELIVERY part and ৳10 packaging
   is added on top, so a failed Sub-Urban delivery deducts ৳110 in total
   (Inside = ৳80, Outside = ৳130). */
var FEE_DELIVERY_SUBURBAN = 100;
var FEE_PACKAGING = 10;
/* The supplier keeps a flat packaging fee when the product actually comes back
   to them — they do not earn anything else on a failed/returned order. */
var SUPPLIER_PACKAGING_CREDIT = 10;

/* FAIL/RETURN statuses — used for GROUPING (the "Returned" view). */
function orderIsFailStatus(s) {
    var k = String(s || '').toLowerCase();
    return k === 'failed_delivery' || k === 'returned' || k === 'return';
}
/* 2026-09-15 — the reseller is charged for a FAILED DELIVERY ONLY.
   A plain RETURN must not touch the reseller's packaging/shipping money:
   "যদি রিটার্ন দেখানো হয় ... টাকা কাটা হবে না। শুধুমাত্র ফেল ডেলিভারি
   দেখানো হইলেই টাকা কাটা হবে।"
   Kept separate from orderIsFailStatus() on purpose — grouping and charging are
   two different questions and must never be conflated again. */
function orderTriggersResellerCharge(s) {
    return String(s || '').toLowerCase() === 'failed_delivery';
}
/* The four supplier-only statuses. These are for the SUPPLIER's view of where a
   failed/returned product physically is; admin picks one per order. */
var SUPPLIER_RETURN_STAGES = [
    { k: 'failed_delivery_product_coming', l: 'Failed Delivery Product Coming' },
    { k: 'failed_delivery_product_delivered', l: 'Failed Delivery Product Delivered to Supplier' },
    { k: 'return_product_coming', l: 'Return Product is Coming' },
    { k: 'return_product_delivered', l: 'Return Product Delivered to Supplier' }
];
function isSupplierReturnStage(s) {
    var k = String(s || '').toLowerCase();
    for (var i = 0; i < SUPPLIER_RETURN_STAGES.length; i++) if (SUPPLIER_RETURN_STAGES[i].k === k) return true;
    return false;
}
/* 2026-09-15 — SUPERSEDES the earlier rule. The supplier's flat ৳10 packaging fee
   is earned when the order is marked FAILED DELIVERY or RETURN.
   The four supplier-LOCATION statuses ("... Product Coming",
   "... Delivered to Supplier") pay the supplier NOTHING AT ALL — not even this
   ৳10. The user was explicit about that. */
function supplierPackagingEarned(s) {
    var k = String(s || '').toLowerCase();
    return k === 'failed_delivery' || k === 'returned' || k === 'return';
}
/* 2026-09-18 (this request) — the tier now has THREE values, so this can no
   longer be "anything that is not outside". A Sub-Urban order is neither the
   inside nor the outside fee, and it must not silently inherit either one. */
function orderInsideDhaka(o) { return orderDeliveryTier(o) === 'inside'; }
function failedDeliveryChargeFor(o) {
    var t = orderDeliveryTier(o);
    var fee = t === 'suburban' ? FEE_DELIVERY_SUBURBAN
            : (t === 'outside' ? FEE_DELIVERY_OUTSIDE : FEE_DELIVERY_INSIDE);
    return fee + FEE_PACKAGING;
}
function failedDeliveryNote(o) {
    var t = orderDeliveryTier(o);
    if (t === 'suburban') return 'Dhaka Sub-Urban ৳' + FEE_DELIVERY_SUBURBAN;
    return t === 'outside'
        ? 'Outside Dhaka ৳' + FEE_DELIVERY_OUTSIDE
        : 'Inside Dhaka ৳' + FEE_DELIVERY_INSIDE;
}
/* My Shop orders (the reseller selling their OWN uploaded product) are exempt —
   the user was explicit: this rule must never touch My Shop orders. */
function orderIsMyShopOrder(o) {
    try {
        if (typeof orderHasResellerOwnedLine === 'function' && orderHasResellerOwnedLine(o)) return true;
    } catch (e) {}
    return false;
}

/* Deduct the failed-delivery charge from the reseller. IDEMPOTENT: an order that
   already carries `failedDeducted` is never charged twice, and a My Shop order is
   never charged at all. Returns the fee (0 when nothing was charged). */
function chargeFailedDelivery(o) {
    if (!o) return 0;
    if (o.failedDeducted) return 0;
    /* the RULE lives here, not in the caller: only a FAILED DELIVERY charges.
       A plain return, or any of the four supplier-location statuses, must never
       move the reseller's money — even if a page calls this by mistake. */
    if (!orderTriggersResellerCharge(o.status)) return 0;
    if (orderIsMyShopOrder(o)) return 0;
    var fee = failedDeliveryChargeFor(o);
    var ok = false;
    try {
        var rs = getData(DB_KEYS.RESELLERS) || [];
        for (var i = 0; i < rs.length; i++) {
            if (String(rs[i].id) === String(o.resellerId)) { rs[i].balance = (rs[i].balance || 0) - fee; ok = true; break; }
        }
        if (ok) setData(DB_KEYS.RESELLERS, rs);
    } catch (e) { ok = false; }
    if (!ok) return 0;
    o.failedDeducted = true;
    o.failedFee = fee;
    try { addTransaction(o.resellerId, 'debit', fee, 'Failed delivery charge — Order ' + o.id + ' (' + failedDeliveryNote(o) + ' + ৳' + FEE_PACKAGING + ' packaging)', 'failed_delivery'); } catch (e) {}
    try { addNotification(o.resellerId, 'balance', 'Order ' + o.id + ' failed delivery! ৳' + fee + ' deducted (' + failedDeliveryNote(o) + ' delivery + ৳' + FEE_PACKAGING + ' packaging).', true); } catch (e) {}
    try { if (typeof logActivity === 'function') logActivity('failed_delivery_charge', '৳' + fee + ' deducted for failed delivery ' + o.id); } catch (e) {}
    return fee;
}
/* Refund it if a failed order is later delivered (the existing behaviour). */
function refundFailedDelivery(o) {
    if (!o || !o.failedDeducted || !o.failedFee) return 0;
    try {
        var rs = getData(DB_KEYS.RESELLERS) || [];
        for (var i = 0; i < rs.length; i++) {
            if (String(rs[i].id) === String(o.resellerId)) { rs[i].balance = (rs[i].balance || 0) + o.failedFee; break; }
        }
        setData(DB_KEYS.RESELLERS, rs);
    } catch (e) { return 0; }
    o.failedDeducted = false;
    try { addTransaction(o.resellerId, 'credit', o.failedFee, 'Refund — failed delivery charge returned (Order ' + o.id + ' re-delivered)', 'failed_delivery'); } catch (e) {}
    try { addNotification(o.resellerId, 'balance', 'Order ' + o.id + ' re-delivered! ৳' + o.failedFee + ' failed-delivery charge refunded to your account.', true); } catch (e) {}
    return o.failedFee || 0;
}
/* The supplier earns NOTHING unless the product is delivered — the single
   exception is the flat 10 Taka packaging fee, credited only once the failed or
   returned product is physically back with them. */
function creditSupplierPackaging(o) {
    if (!o) return 0;
    if (!supplierPackagingEarned(o.status)) return 0;
    if (o.supplierPackagingCredited) return 0;
    var ids = [];
    try { if (typeof orderSupplierIds === 'function') ids = orderSupplierIds(o) || []; } catch (e) {}
    if (!ids.length && o.supplierId) ids = [o.supplierId];
    if (!ids.length) return 0;
    try {
        var sups = getData(DB_KEYS.SUPPLIERS) || [];
        for (var s = 0; s < ids.length; s++) {
            for (var i = 0; i < sups.length; i++) {
                if (String(sups[i].id) === String(ids[s])) {
                    sups[i].balance = (sups[i].balance || 0) + SUPPLIER_PACKAGING_CREDIT;
                    sups[i].packagingEarning = (sups[i].packagingEarning || 0) + SUPPLIER_PACKAGING_CREDIT;
                    break;
                }
            }
        }
        setData(DB_KEYS.SUPPLIERS, sups);
    } catch (e) { return 0; }
    o.supplierPackagingCredited = true;
    try { if (typeof logActivity === 'function') logActivity('supplier_packaging_credit', '৳' + SUPPLIER_PACKAGING_CREDIT + ' packaging credited for order ' + o.id); } catch (e) {}
    return SUPPLIER_PACKAGING_CREDIT;
}

/* ==========================================================================
   WEBSITE INTEGRATION  (2026-09-15)
   Every reseller gets their OWN API key, so they can connect their own
   WordPress / Shopify / hand-coded site to ResellerHub BD:
     - the site pulls our product feed (supplier-uploaded + admin-uploaded)
     - a product we take out of stock, or delete, leaves that feed by itself
     - an order placed on their site comes straight into their reseller panel
   The key is per reseller and is the ONLY thing that scopes the feed — one
   reseller can never pull another reseller's data.
   ========================================================================== */
function resellerApiKeyBase(rid) {
    var s = String(rid === undefined || rid === null ? '' : rid).replace(/[^A-Za-z0-9]/g, '');
    return s || '0';
}
function makeResellerApiKey(rid) {
    var rnd = '';
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (var i = 0; i < 24; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));
    return 'rh_' + resellerApiKeyBase(rid) + '_' + rnd;
}
/* The reseller's key. Generates one on first use and persists it, so the same
   key keeps working after a reload. Returns '' only if storage is unavailable. */
function resellerApiKey(rid) {
    try {
        var rs = getData(DB_KEYS.RESELLERS) || [];
        for (var i = 0; i < rs.length; i++) {
            if (String(rs[i].id) === String(rid)) {
                var k = String(rs[i].apiKey || rs[i].api_key || '').trim();
                if (!k) { k = makeResellerApiKey(rid); rs[i].apiKey = k; rs[i].api_key = k; setData(DB_KEYS.RESELLERS, rs); }
                return k;
            }
        }
    } catch (e) {}
    return '';
}
function regenerateResellerApiKey(rid) {
    try {
        var rs = getData(DB_KEYS.RESELLERS) || [];
        for (var i = 0; i < rs.length; i++) {
            if (String(rs[i].id) === String(rid)) {
                var k = makeResellerApiKey(rid);
                rs[i].apiKey = k; rs[i].api_key = k;
                setData(DB_KEYS.RESELLERS, rs);
                try { if (typeof logActivity === 'function') logActivity('api_key_regenerated', 'reseller ' + rid); } catch (e) {}
                return k;
            }
        }
    } catch (e) {}
    return '';
}
/* Which reseller owns a key. The backend uses this to authenticate a request. */
function resellerByApiKey(key) {
    var k = String(key || '').trim();
    if (!k) return null;
    try {
        var rs = getData(DB_KEYS.RESELLERS) || [];
        for (var i = 0; i < rs.length; i++) {
            if (String(rs[i].apiKey || rs[i].api_key || '').trim() === k) return rs[i];
        }
    } catch (e) {}
    return null;
}
/* WHAT THE EXTERNAL SITE RECEIVES.
   shopVisibleProducts() is the ONE query that already applies every rule —
   stock > 0, not an unapproved supplier product, is_active !== false, the
   category not switched off, and the "never another reseller's product" rule.
   So a product we take out of stock, deactivate or delete simply stops
   appearing here: the integration needs no extra logic. */
function apiProductFeed(rid) {
    var out = [];
    try {
        var ps = shopVisibleProducts(rid);
        for (var i = 0; i < ps.length; i++) {
            var p = ps[i];
            /* IMAGE: `p.image` may be an `@img:<id>` reference (a big image is
               spilled to IndexedDB and replaced by that marker — see RH_IMG_REF).
               Sending the marker to an outside website gives a broken image, so
               resolve it through rhImgUrl() and send '' when it cannot be
               resolved. An empty image is honest; "@img:i3kf9" is not. */
            var img = '';
            try {
                if (typeof rhImgUrl === 'function') img = rhImgUrl(p.image) || '';
                else if (typeof rhImgIsRef !== 'function' || !rhImgIsRef(p.image)) img = String(p.image || '');
            } catch (e) { img = ''; }
            if (img.indexOf('@img:') === 0) img = '';      /* never leak a marker */
            out.push({
                id: String(p.id),
                name: String(p.name || ''),
                sku: String(p.sku || ''),
                price: (typeof retail === 'function') ? retail(p) : (Number(p.customer_price) || 0),
                image: img,
                stock: Number(p.stock) || 0,
                category: String(p.category || ''),
                sub: String(p.section || p.subSection || ''),
                subsub: String(p.subSub || ''),
                description: String(p.description || '')
            });
        }
    } catch (e) { return []; }
    return out;
}
/* AN ORDER FROM THE EXTERNAL SITE.
   Builds the order in exactly the shape the app already uses, so the EXISTING
   derived routing classifies it correctly with no special cases:
     - 2+ suppliers among the lines  -> a multi-supplier order (admin + supplier
       Multi-Supplier pages)
     - 1 supplier                    -> a normal order for that supplier
     - the reseller's OWN product    -> its line belongs to My Shop, while the
       whole order still appears in All Orders
   Returns {ok, id} or {ok:false, error}. */
function apiIngestOrder(payload, rid) {
    try {
        payload = payload || {};
        var items = asArray(payload.items);
        if (!items.length) return { ok: false, error: 'no items' };
        var prods = getData(DB_KEYS.PRODUCTS) || [];
        var byId = {};
        for (var i = 0; i < prods.length; i++) byId[String(prods[i].id)] = prods[i];

        /* only products this reseller is allowed to sell may be ordered */
        var allowed = {};
        var vis = shopVisibleProducts(rid);
        for (var v = 0; v < vis.length; v++) allowed[String(vis[v].id)] = true;

        var lines = [], total = 0, qtyAll = 0;
        for (var j = 0; j < items.length; j++) {
            var it = items[j] || {};
            var pid = String(it.productId || it.id || '');
            if (!allowed[pid]) return { ok: false, error: 'product not available: ' + pid };
            var p = byId[pid] || {};
            var qty = Math.max(1, parseInt(it.qty, 10) || 1);
            var line = {
                productId: pid,
                name: String(p.name || it.name || ''),
                qty: qty,
                price: Number(p.price) || 0,
                resale: (typeof retail === 'function') ? retail(p) : (Number(p.customer_price) || 0),
                image: String(p.image || ''),
                supplierId: p.supplierId || null,
                product_owner_type: (typeof productOwnerType === 'function') ? productOwnerType(p) : 'admin',
                product_owner_id: p.product_owner_id || p.ownerResellerId || null,
                ownerResellerId: p.ownerResellerId || null
            };
            total += line.resale * qty;
            qtyAll += qty;
            lines.push(line);
        }
        var ship = Number(payload.shippingCharge) || 0;
        var profit = 0;
        for (var m = 0; m < lines.length; m++) profit += (lines[m].resale - lines[m].price) * lines[m].qty;
        profit = profit - Math.round((total + ship) * 0.01) - 10;
        if (profit < 0) profit = 0;

        var orders = getData(DB_KEYS.ORDERS) || [];
        var o = {
            id: (typeof getNextOrderId === 'function') ? getNextOrderId() : ('ORD-' + Date.now()),
            resellerId: rid,
            customer: String(payload.customer || payload.name || 'Website customer'),
            phone: String(payload.phone || ''),
            address: String(payload.address || ''),
            items: lines,
            qty: qtyAll,
            amount: total + ship,
            shippingCharge: ship,
            shippingMethod: String(payload.shippingMethod || 'inside'),
            profit: profit,
            status: 'new',
            date: new Date().toISOString().split('T')[0],
            source: 'website_integration',
            externalOrderId: String(payload.externalOrderId || payload.orderId || ''),
            channel: String(payload.channel || 'website')
        };
        orders.push(o);
        if (!setData(DB_KEYS.ORDERS, orders)) return { ok: false, error: 'storage unavailable' };
        /* Stock: both normal order paths (my-shop-checkout.html and order.html)
           call this, so an API order must too — otherwise the reseller's OWN
           product sold through their site would never come off stock, and the
           feed would keep offering it. It only ever moves the reseller's own
           inventory (see the function's own guard). */
        try { applyOwnProductStockDeduction(o, rid); } catch (e) {}
        try { addTracking(o.id, 'New', 'Website Integration', 'Order received from ' + (o.channel || 'website')); } catch (e) {}
        try { addNotification(1, 'order', 'New order ' + o.id + ' from a reseller website integration.', true); } catch (e) {}
        try { if (typeof logActivity === 'function') logActivity('api_order_in', o.id + ' from reseller ' + rid); } catch (e) {}
        return { ok: true, id: o.id };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
/* Push this reseller's key + catalogue UP to the backend, so their site has a
   feed to read. */
function apiSyncPush(rid, apiBase) {
    var key = resellerApiKey(rid);
    if (!key) return Promise.resolve({ ok: false, error: 'no api key' });
    /* never assume fetch exists — an unguarded call throws, and a throw inside a
       .then() becomes an UNHANDLED REJECTION, which takes the whole page (and the
       test suite running it) down with it. */
    if (typeof fetch !== 'function') return Promise.resolve({ ok: false, error: 'fetch unavailable' });
    return fetch(apiBase + '?action=sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resellerId: String(rid), key: key, products: apiProductFeed(rid) })
    }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: String(e) }; });
}
/* Pull orders placed on the reseller's own site INTO the panel, then tell the
   backend they have been ingested so they are never imported twice. */
function apiSyncPull(rid, apiBase) {
    var key = resellerApiKey(rid);
    if (!key) return Promise.resolve({ ok: false, error: 'no api key' });
    if (typeof fetch !== 'function') return Promise.resolve({ ok: false, error: 'fetch unavailable' });
    return fetch(apiBase + '?action=orders&key=' + encodeURIComponent(key))
        .then(function (r) { return r.json(); })
        .then(function (d) {
            var list = (d && d.orders) || [], done = [], failed = 0;
            for (var i = 0; i < list.length; i++) {
                var res = apiIngestOrder(list[i], rid);
                if (res.ok) done.push(String(list[i].id)); else failed++;
            }
            if (!done.length) return { ok: true, imported: 0, failed: failed };
            return fetch(apiBase + '?action=ack&key=' + encodeURIComponent(key), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: done })
            }).then(function () { return { ok: true, imported: done.length, failed: failed }; })
              .catch(function () { return { ok: true, imported: done.length, failed: failed, ackFailed: true }; });
        })
        .catch(function (e) { return { ok: false, error: String(e) }; });
}
function apiSyncNow(rid, apiBase) {
    return apiSyncPush(rid, apiBase).then(function (p) {
        return apiSyncPull(rid, apiBase).then(function (q) {
            return { push: p, pull: q };
        });
    });
}
/* Where the backend lives, derived from the current page. */
function apiBaseUrl() {
    try {
        if (typeof location === 'undefined') return '';
        return location.href.replace(/[^\/]*$/, '').replace(/(admin|reseller|supplier)\/$/, '') + 'backend/api/resellerhub-api.php';
    } catch (e) { return ''; }
}
/* 2026-09-15 — AUTOMATIC sync, so the reseller does not have to press anything:
     - orders placed on their own site arrive on their own
     - the product catalogue is re-sent when it has changed
   Throttled hard (5 minutes) and completely silent: if the backend is not
   deployed yet, or the browser is offline, this must never disturb the panel.
   Reseller setting `autoSync` (default ON) turns it off. */
var RH_AUTO_SYNC_MS = 5 * 60 * 1000;
function shopAutoSyncOn(rid) {
    try {
        var s = getShopSettings(rid);
        return !(s && s.autoSync === false);
    } catch (e) { return true; }
}
function setShopAutoSync(rid, on) { return patchShopSettings(rid, { autoSync: !!on }); }
function apiCatalogueStamp(rid) {
    try {
        var ps = shopVisibleProducts(rid), parts = [];
        for (var i = 0; i < ps.length; i++) {
            parts.push(String(ps[i].id) + ':' + (Number(ps[i].stock) || 0) + ':' + ((typeof retail === 'function') ? retail(ps[i]) : ''));
        }
        parts.sort();
        return parts.join('|');
    } catch (e) { return ''; }
}
function apiAutoSync(rid, force) {
    try {
        if (!rid) return Promise.resolve({ skipped: 'no rid' });
        if (!shopAutoSyncOn(rid)) return Promise.resolve({ skipped: 'off' });
        var base = apiBaseUrl();
        if (!base || base.indexOf('http') !== 0) return Promise.resolve({ skipped: 'no base' });
        var now = Date.now();
        var last = parseInt(sessionStorage.getItem('rh_autosync_at') || '0', 10) || 0;
        if (!force && (now - last) < RH_AUTO_SYNC_MS) return Promise.resolve({ skipped: 'throttled' });
        sessionStorage.setItem('rh_autosync_at', String(now));

        /* push only when the catalogue actually changed; ALWAYS pull orders */
        var stamp = apiCatalogueStamp(rid);
        var lastStamp = sessionStorage.getItem('rh_autosync_stamp') || '';
        var push = (force || stamp !== lastStamp)
            ? apiSyncPush(rid, base).then(function (r) { sessionStorage.setItem('rh_autosync_stamp', stamp); return r; })
            : Promise.resolve({ ok: true, skipped: 'unchanged' });
        return push.then(function (p) {
            return apiSyncPull(rid, base).then(function (q) {
                if (q && q.imported) {
                    try { if (typeof renderOrders === 'function') renderOrders(); } catch (e) {}
                }
                return { push: p, pull: q };
            });
        }).catch(function (e) { return { skipped: 'error' }; });   /* a failed auto sync is ALWAYS silent */
    } catch (e) { return Promise.resolve({ skipped: 'error' }); }
}
/* Fire once per page load for a signed-in reseller. Wrapped so a failure can
   never break the page it runs on. */
try {
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('DOMContentLoaded', function () {
            try {
                var t = sessionStorage.getItem('user_type');
                var u = sessionStorage.getItem('user_id');
                if (t !== 'reseller' || !u) return;
                setTimeout(function () { try { apiAutoSync(u); } catch (e) {} }, 1500);
            } catch (e) {}
        });
    }
} catch (e) {}

function orderStageKey(status) {
    var k = String(status === undefined || status === null || status === '' ? 'new' : status).toLowerCase();
    if (ORDER_STAGE_ALIAS[k]) k = ORDER_STAGE_ALIAS[k];
    return k;
}
function orderStageIndex(status) {
    var k = orderStageKey(status);
    for (var i = 0; i < ORDER_STAGES.length; i++) if (ORDER_STAGES[i].k === k) return i;
    return -1;
}
function orderStageLabel(status) {
    var i = orderStageIndex(status);
    if (i >= 0) return ORDER_STAGES[i].l;
    var k = orderStageKey(status);
    if (k === 'returned') return 'Returned';
    if (k === 'wfr') return 'WFR (Waiting for Return)';
    if (k === 'cancel' || k === 'cancelled') return 'Cancelled';
    return String(status || 'New');
}
/* A compact "which stage is the parcel at" strip. The ADMIN uses it as a
   setter; the SUPPLIER and the RESELLER read the same strip read-only, so all
   three panels report the same stage for the same order. */
function orderStageStripHtml(status) {
    var idx = orderStageIndex(status);
    var off = !!ORDER_STAGE_OFF[orderStageKey(status)];
    var h = '<div class="ostage' + (off ? ' off' : '') + '">';
    if (off) {
        h += '<span class="ostep done">' + ORDER_STAGES[0].l + '</span>' +
             '<span class="ostep cur bad">' + orderStageLabel(status) + '</span>';
    } else {
        for (var i = 0; i < ORDER_STAGES.length; i++) {
            var cls = (i < idx) ? 'done' : (i === idx ? 'cur' : '');
            h += '<span class="ostep ' + cls + '">' + ORDER_STAGES[i].l + '</span>';
        }
    }
    return h + '</div>';
}

/* ---------------------------------------------------------------------------
   ITEM 10 (spec, 2026-09-14) — "রিসেলার প্যানেলের মাইশপ অর্ডারসগুলা রিসেলার চাইলে
   কনফার্ম প্যাকেজিং শিপি ডেলিভার্ড এগুলো মার্ক করতে পারবে। এই অপশনগুলো
   রিসেলারকে দিয়ে দাও শুধুমাত্র মাইশপ অর্ডারসগুলোর জন্য।"
   ONE guarded writer, so the reseller page cannot invent a stage the admin page
   does not understand and the ownership rule lives in exactly one place.
   --------------------------------------------------------------------------- */
/* The four stages a reseller may mark. Deliberately NOT the full ORDER_STAGES
   list: `new` is where an order starts (the reseller would only ever move it
   forward), and the courier-owned middle steps are the platform's business.
   These are the CANONICAL stage keys, not ad-hoc words: `shipping` (shown as
   "Shipping") is the pipeline step the admin page sets when a parcel is shipped,
   and `shipped` is only an alias that orderStageKey() folds into it — so using
   the canonical key is what keeps the dropdown's "selected" state, the strip and
   the admin panel all agreeing on one value. */
var RESELLER_STAGE_OPTIONS = ['confirmed', 'packaging', 'shipping', 'delivered'];

/* OWNERSHIP GUARD. A reseller may stage an order ONLY when it is both theirs AND
   a My Shop order — i.e. it carries at least one product they uploaded
   themselves. An admin-only or supplier-only order that merely happens to sit
   under their account is never stage-markable from the reseller panel, which is
   what "শুধুমাত্র মাইশপ অর্ডারসগুলোর জন্য" means. */
function resellerCanStageOrder(o, rid) {
    if (!o || rid === undefined || rid === null || rid === '') return false;
    if (!orderBelongsToReseller(o, rid)) return false;
    return !!orderHasOwnProduct(o, rid);
}
/* Returns { ok, reason, from, to, label }. Never throws: every side effect after
   the data write is wrapped, because an exception there would abort the caller
   AFTER the status had already been saved (the "saved but the UI never updated"
   failure this codebase has hit before). */
function rhSetOrderStage(oid, stage, opts) {
    opts = opts || {};
    var orders = getData(DB_KEYS.ORDERS) || [], o = null;
    for (var i = 0; i < orders.length; i++) { if (String(orders[i].id) === String(oid)) { o = orders[i]; break; } }
    if (!o) return { ok: false, reason: 'notfound' };
    var st = String(stage || '');
    if (!st) return { ok: false, reason: 'nostage' };
    if (orderStageIndex(st) < 0) return { ok: false, reason: 'badstage' };
    if (String(opts.actorType) === 'reseller' && !resellerCanStageOrder(o, opts.actorId)) {
        return { ok: false, reason: 'notowner' };
    }
    var was = String(o.status || '');
    if (st === was) return { ok: true, unchanged: true, from: was, to: st, label: orderStageLabel(st) };
    o.status = st;
    if (st === 'delivered' && !o.deliveryDate) o.deliveryDate = new Date().toISOString().split('T')[0];
    setData(DB_KEYS.ORDERS, orders);
    var label = orderStageLabel(st), who = opts.actorLabel || 'ResellerHub';
    try { addTracking(o.id, label, who, 'Stage set to ' + label); } catch (e) {}
    /* Tell the OTHER side. A reseller's move is the admin's business; the admin
       moving it is the reseller's. Both are persistent so the notice cannot be
       scrolled away before it is seen. */
    try {
        if (String(opts.actorType) === 'reseller') {
            addNotification(1, 'order', 'Order ' + o.id + ' — ' + label + ' (My Shop, reseller)', true);
        } else if (o.resellerId) {
            addNotification(o.resellerId, 'order', 'Order ' + o.id + ' — ' + label, true);
        }
    } catch (e) {}
    try { logActivity('order_stage', o.id + ' stage ' + was + ' -> ' + st + ' by ' + who); } catch (e) {}
    return { ok: true, from: was, to: st, label: label };
}

/* ---------- 2. product-wise order summary ----------
   ONE aggregation, shared by the Admin All Orders page, the Admin
   Multi-Supplier page and the Supplier Multi-Supplier page.
   ROUTING (spec, 2026-09-14): a MULTI-SUPPLIER order counts in the
   Multi-Supplier summary ONLY — it must never appear in the All Orders
   summary, in either panel.
     opts.multi       true  -> ONLY multi-supplier orders
                      false -> multi-supplier orders EXCLUDED (the default)
     opts.supplierId  restrict to this supplier's OWN lines (supplier privacy)
     opts.priceOf     money resolver; defaults to the customer-facing resale
                      price, which is what the Admin view shows. The supplier
                      panel passes its own cost resolver instead.
   Returns rows { key, name, qty, revenue, img, resellers:{} } sorted by qty. */
/* 2026-09-15 — the product-wise summary counts ONLY orders still in
   new / confirmed / pending. Everything from 'packaging' onward (packaging,
   handed to courier, shipping, in transit, delivered) and EVERY fail/return
   status is excluded: a product that has moved past confirmation is no longer
   pending work and must not appear here.

   Normalised through the app's canonical `orderStageKey()` rather than compared
   as a raw string, so the legacy spellings resolve the same way they do
   everywhere else ('pending' / 'processing' -> 'new', 'shipped' -> 'shipping').
   A hand-maintained list would drift out of step with ORDER_STAGE_ALIAS.
   Off-pipeline statuses pass through unchanged and are therefore excluded. */
var PRODUCT_SUMMARY_STAGES = { 'new': 1, 'confirmed': 1 };
function productSummaryStatusIncluded(status) {
    var k = String(status === undefined || status === null || status === '' ? 'new' : status).toLowerCase().trim();
    if (typeof orderStageKey === 'function') { try { k = orderStageKey(k); } catch (e) {} }
    return !!PRODUCT_SUMMARY_STAGES[k];
}

function productWiseOrderSummary(orders, opts) {
    opts = opts || {};
    var sid = (opts.supplierId === undefined || opts.supplierId === null) ? '' : String(opts.supplierId);
    var onlyMulti = !!opts.multi;
    var priceOf = (typeof opts.priceOf === 'function')
        ? opts.priceOf
        : function (it) { return Number(it.resale) || 0; };
    var list = asArray(orders), map = {};

    function rowOf(key, img) {
        if (!map[key]) map[key] = { key: key, name: key, qty: 0, revenue: 0, img: img || '', resellers: {} };
        else if (!map[key].img && img) map[key].img = img;
        return map[key];
    }
    function bump(key, img, n, unit, rid) {
        var r = rowOf(key, img);
        r.qty += n;
        r.revenue += unit * n;
        if (rid !== undefined && rid !== null && rid !== '') r.resellers[String(rid)] = 1;
    }

    for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (!o) continue;
        var isMulti = (typeof isMultiSupplierOrder === 'function') && isMultiSupplierOrder(o);
        if (onlyMulti ? !isMulti : isMulti) continue;          /* the routing rule */
        if (!productSummaryStatusIncluded(o.status)) continue;

        var items = orderLineItems(o);
        if (!items.length) {
            /* legacy single-product order — the stored total is added ONCE,
               exactly as the Admin All Orders summary has always done. */
            if (typeof orderItemIsResellerOwned === 'function' &&
                orderItemIsResellerOwned({ productId: o.productId, product_owner_type: o.product_owner_type, product_source: o.product_source, product_owner_id: o.product_owner_id })) continue;
            if (sid && !(typeof orderItemIsSupplier === 'function' &&
                orderItemIsSupplier({ productId: o.productId, supplierId: o.supplierId, product_owner_type: o.product_owner_type, product_owner_id: o.product_owner_id }, sid))) continue;
            var lp = (typeof findProductById === 'function') ? findProductById(o.productId) : null;
            var lk = String(o.productName || 'Product') + (o.size ? ' — Size: ' + o.size : '') + (o.color ? ' • ' + o.color : '');
            var lr = rowOf(lk, (lp && lp.image) || '');
            lr.qty += Number(o.qty) || 1;
            lr.revenue += Number(o.amount) || 0;
            if (o.resellerId !== undefined && o.resellerId !== null && o.resellerId !== '') lr.resellers[String(o.resellerId)] = 1;
            continue;
        }
        for (var q = 0; q < items.length; q++) {
            var it = items[q] || {};
            if (typeof orderItemIsResellerOwned === 'function' && orderItemIsResellerOwned(it)) continue;
            if (sid && !(typeof orderItemIsSupplier === 'function' && orderItemIsSupplier(it, sid))) continue;
            var p = (typeof findProductById === 'function') ? findProductById(it.productId) : null;
            var img = String(it.image || (p && p.image) || '');
            var cl = it.color || '', szs = [];
            if (it.sizeQty && it.sizeQty.length) {
                for (var z = 0; z < it.sizeQty.length; z++) {
                    if ((Number(it.sizeQty[z].qty) || 0) > 0) szs.push({ s: it.sizeQty[z].size || 'Free Size', n: Number(it.sizeQty[z].qty) || 0 });
                }
            }
            if (!szs.length) szs.push({ s: it.size || 'Free Size', n: Number(it.qty) || 1 });
            for (var z2 = 0; z2 < szs.length; z2++) {
                var sz = szs[z2].s;
                bump(String(it.name || 'Product') + (sz ? ' — Size: ' + sz : '') + (cl ? ' • ' + cl : ''),
                     img, szs[z2].n, priceOf(it, p), o.resellerId);
            }
        }
    }
    var out = [];
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out.push(map[k]);
    out.sort(function (a, b) { return (b.qty - a.qty) || String(a.key).localeCompare(String(b.key)); });
    return out;
}

/* ---------- 3. per-supplier invoices ----------
   SPEC (2026-09-14): for a Multi-Supplier order the admin prints ONE INVOICE
   PER SUPPLIER — 2 suppliers -> 2 invoices, 3 suppliers -> 3. Each invoice
   lists ONLY that supplier's lines and carries that supplier's own subtotal.
   Admin and reseller lines are never invoiced here. */
function multiSupplierInvoiceGroups(o) {
    /* Scoped to MULTI-SUPPLIER orders on purpose: an ordinary single-supplier
       order already has its own invoice on the All Orders page, and printing a
       "supplier invoice" for it would silently duplicate that. Returning [] here
       makes the contract crisp — this helper only ever answers the question
       "how many suppliers does this multi-supplier order have to invoice?". */
    if (!(typeof isMultiSupplierOrder === 'function' && isMultiSupplierOrder(o))) return [];
    var groups = (typeof orderSupplierGroups === 'function') ? orderSupplierGroups(o, 'admin', '') : [];
    var out = [];
    for (var i = 0; i < groups.length; i++) {
        if (groups[i].kind !== 'supplier' || !groups[i].items.length) continue;
        out.push(groups[i]);
    }
    return out;
}
function multiSupplierInvoiceCount(o) { return multiSupplierInvoiceGroups(o).length; }

/* Reuse the EXACT stylesheet of the standard order print, so a supplier
   invoice can never drift away from the invoice the admin already trusts.
   Rendering one throwaway order and lifting its <style> keeps the two
   documents locked together without duplicating 50 lines of CSS. */
function adminPrintCssFor(format) {
    var tpl = '';
    try { tpl = adminOrderPrintHtml([{}], format); } catch (e) { tpl = ''; }
    var m = tpl.match(/<style>([\s\S]*?)<\/style>/);
    return m ? m[1] : '';
}

/* ONE supplier's invoice. Same class names and therefore the same visual
   language as the standard sheet — only the identity block changes: the
   SUPPLIER is the header, because this slip travels with that supplier's
   portion of the package. */
function multiSupplierInvoiceSheet(o, g, seq, count, format) {
    /* 2026-09-18 (this request) — A4/A5 render the UNIFIED INVOICE sheet, built
       from THIS supplier's own lines (g.items already carries productId, image,
       price and variant). It is an ADMIN sheet, so it carries the four reseller
       details as well. Labels keep the layout below. */
    if (format !== 'label32' && format !== 'label33') {
        var sup0 = (typeof findSupplierById === 'function') ? findSupplierById(g.ownerId) : null;
        var supName0 = (sup0 && (sup0.shopName || sup0.name)) || g.label || ('Supplier #' + g.ownerId);
        /* `g.items[].price` is ALREADY this supplier's selling price (computed by
           orderSupplierGroups via itemSellingPrice). Pass it as an explicit
           `retail` so the sheet can never re-derive a different number. */
        var git = [];
        for (var q = 0; q < g.items.length; q++) {
            var gi = g.items[q];
            git.push({
                name: gi.name, qty: gi.qty, variant: gi.variant, image: gi.image,
                sku: gi.sku, productId: gi.productId, retail: Number(gi.price) || 0
            });
        }
        return rhInvSheet(
            rhInvData(o, {
                mode: 'admin',
                items: git,
                subset: true,
                shopId: shipShopId(),
                title: 'SUPPLIER INVOICE \u00b7 ' + supName0 + ' \u00b7 Supplier ' + seq + ' of ' + count
            }),
            format, {});
    }
    var esc = function (v) {
        return String(v === undefined || v === null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    var money = function (n) { return '&#2547;' + (Number(n) || 0).toLocaleString('en-IN'); };

    var sup = (typeof findSupplierById === 'function') ? findSupplierById(g.ownerId) : null;
    var supName = (sup && (sup.shopName || sup.name)) || g.label || ('Supplier #' + g.ownerId);
    var supPhone = (sup && (sup.phone || sup.shop_phone)) || '';
    var supAddr = (sup && (sup.shop_address || sup.address || sup.businessAddress)) || '';

    var rows = '', subtotal = 0, qty = 0;
    for (var i = 0; i < g.items.length; i++) {
        var it = g.items[i];
        subtotal += Number(it.lineTotal) || 0;
        qty += Number(it.qty) || 1;
        rows += '<tr><td class="pn">' + esc(it.name) + ' <span class="qx">&times; ' + esc(it.qty) + '</span>' +
            (it.variant ? '<span class="vr">' + esc(it.variant) + '</span>' : '') +
            '</td><td class="pp">' + money(it.lineTotal) + '</td></tr>';
    }
    if (!rows) rows = '<tr><td class="pn">Order items</td><td class="pp">&mdash;</td></tr>';

    var parcel = (typeof adminOrderParcelId === 'function') ? adminOrderParcelId(o) : '';
    var shop = (typeof shipShopId === 'function') ? shipShopId() : '';
    var parcelBlock = parcel
        ? '<div class="pid"><small>PARCEL ID</small>' + esc(parcel) + '</div><div class="shop">Shop ID: ' + esc(shop) + '</div>'
        : '<div class="pid na"><small>PARCEL ID</small>Not Available</div><div class="shop">Shop ID: ' + esc(shop) + '</div>';

    return '<div class="sheet' + (format === 'a5' ? ' a5' : '') + '">' +
        '<div class="hd">' +
        '<div class="hd-l">' +
        '<div class="rname">' + esc(supName) + '</div>' +
        (supPhone ? '<div class="rline">&#9742; ' + esc(supPhone) + '</div>' : '') +
        (supAddr ? '<div class="rline">' + esc(supAddr) + '</div>' : '') +
        '<div class="rline"><b>SUPPLIER INVOICE</b> &middot; Supplier ' + esc(seq) + ' of ' + esc(count) + '</div>' +
        '</div>' +
        '<div class="hd-r">' + parcelBlock + '</div>' +
        '</div>' +
        '<div class="sect">ORDER DETAILS &mdash; ' + esc(g.label || supName) + '</div>' +
        '<table class="pt"><thead><tr><th>Product</th><th class="pp">Amount</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="sums">' +
        '<div class="srow"><span>Lines</span><b>' + esc(g.lines) + '</b></div>' +
        '<div class="srow"><span>Total Quantity</span><b>' + esc(qty) + ' pcs</b></div>' +
        '<div class="srow total"><span>SUPPLIER SUBTOTAL</span><b>' + money(subtotal) + '</b></div>' +
        '</div>' +
        '<div class="thx"><b>Thank You For Your Order!</b><span>This invoice covers only the items supplied by ' + esc(supName) + '.</span></div>' +
        '<div class="meta"><span>Order: ' + esc(o.id) + '</span><span>' + esc(String(o.date || '').slice(0, 10)) + '</span></div>' +
        '</div>';
}

/* The whole document: every supplier invoice of every selected order, one per
   page. Bulk printing therefore needs no extra machinery — it is the same
   document with more pages. */
function multiSupplierInvoiceHtml(orders, format) {
    var list = asArray(orders), pages = [];
    for (var i = 0; i < list.length; i++) {
        var gs = multiSupplierInvoiceGroups(list[i]);
        for (var j = 0; j < gs.length; j++) pages.push({ o: list[i], g: gs[j], seq: j + 1, count: gs.length });
    }
    if (!pages.length) return '';
    var body = '';
    for (var p = 0; p < pages.length; p++) {
        body += '<div class="page' + (p < pages.length - 1 ? ' brk' : '') + '">' +
            multiSupplierInvoiceSheet(pages[p].o, pages[p].g, pages[p].seq, pages[p].count, format) + '</div>';
    }
    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Supplier Invoices</title>' +
        /* 2026-09-18 — A4/A5 pages here are unified invoice sheets (the CSS comes
           from adminPrintCssFor, which now carries RH_INV_CSS); the fonts have to
           be requested by this document itself. */
        RH_INV_FONTS +
        '<style>' + adminPrintCssFor(format) + '</style></head><body>' + body + '</body></html>';
}

/* ==========================================================================
   RESELLER CONFIRM GATE  (spec, 2026-09-15)
   --------------------------------------------------------------------------
   "সাপ্লায়ার প্যানেলে অর্ডারটা যাইব রিসেলার কনফার্ম করার পর। আর অ্যাডমিন প্যানেলে
    কনফার্ম ছাড়াও শো করবে।"

   The Confirm button on reseller/my-orders.html writes status = 'confirmed'
   ("হ্যাঁ সাপ্লায়ার, আপনার প্রোডাক্ট পাঠাইতে পারেন").  Both entry points create
   an order as status 'new':
       reseller/my-shop-checkout.html   (a My Shop customer order)
       reseller/order.html              (the reseller's own Add Order form)
   so 'new' — and the legacy 'pending' — are exactly the pre-confirm states.

   The gate lives HERE, in the data layer, because every supplier-side view
   reads through supplierOrders() / multiSupplierOrdersFor(): the All Orders
   rows, the nav badge, the "Ship করতে হবে" cards, the report and the earnings
   totals all descend from myOrders() -> supplierOrders().  One predicate, so
   the number on the badge can never disagree with the rows underneath it.

   The ADMIN panel does not use either function — it reads rh_orders directly —
   so an unconfirmed order still reaches Admin -> All Orders / My Shop Orders
   immediately, which is the required behaviour.

   A record with NO status at all stays VISIBLE on purpose: an order written by
   an older build must never vanish from a supplier's list.
   ========================================================================== */
function orderAwaitingResellerConfirm(o) {
    if (!o) return false;
    if (o.status === undefined || o.status === null || o.status === '') return false;
    var s = String(o.status).toLowerCase().trim();
    return s === 'new' || s === 'pending';
}

/* Every order that has at least one line fulfilled by supplier `sid` AND that
   the reseller has already confirmed (see orderAwaitingResellerConfirm). */
function supplierOrders(sid) {
    var orders = getData(DB_KEYS.ORDERS) || [], out = [];
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o) continue;
        if (orderAwaitingResellerConfirm(o)) continue;   /* reseller has not confirmed yet */
        var items = orderLineItems(o);
        for (var j = 0; j < items.length; j++) {
            if (orderItemIsSupplier(items[j], sid)) { out.push(o); break; }
        }
    }
    return out;
}
/* The supplier-owned lines of ONE order (used so a mixed order shows the
   supplier only its own items, never the admin/reseller ones). */
function supplierOrderItems(o, sid) {
    var items = orderLineItems(o), out = [];
    for (var i = 0; i < items.length; i++) {
        if (orderItemIsSupplier(items[i], sid)) out.push(items[i]);
    }
    return out;
}

/* ==========================================================================
   RESELLER OWN PRODUCT
/* Reseller's own-product orders (PART 14, 16) — already exposed as
   resellerOwnProductOrders(rid); kept as the single source of truth. */

/* ==========================================================================
   RESELLER OWN PRODUCT — STOCK · ORDERING · PROFIT · STREET FIRST
   --------------------------------------------------------------------------
   Every page loads app.js, so this block is the single enforcement point.
   Pages may only RENDER what these functions return — they never filter
   ownership themselves, and they never see a Street First secret.
   ========================================================================== */

/* ---------- ownership-safe product sets ------------------------------------
   "selectable" = admin + supplier + THIS reseller's own products.
   Another reseller's product is never returned, no matter what the caller is. */
function resellerSelectableProducts(rid) {
    var ps = getData(DB_KEYS.PRODUCTS) || [], out = [];
    for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (!p) continue;
        if (productOwnerType(p) === 'reseller' && !isResellerOwnProduct(p, rid)) continue;
        out.push(p);
    }
    return out;
}
/* Same set, but only what may actually be ordered right now. */
function resellerOrderableProducts(rid) {
    var list = resellerSelectableProducts(rid), out = [];
    for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (p.is_active === false) continue;
        if (p.supplierId && p.approved === false) continue;
        if (!productInStock(p)) continue;
        out.push(p);
    }
    return out;
}
/* Every own product of this reseller, in stock or not (never another's). */
function resellerOwnProducts(rid) {
    var ps = getData(DB_KEYS.PRODUCTS) || [], out = [];
    for (var i = 0; i < ps.length; i++) if (isResellerOwnProduct(ps[i], rid)) out.push(ps[i]);
    return out;
}
/* ---------- BACKEND-LEVEL ownership guard (spec #5, #12, #13) ----------------
   A reseller order may only contain:
     · admin products, · supplier products, · THIS reseller's own products.
   Another reseller's uploaded product is rejected HERE — in the shared data
   layer every page loads — not by a page-level filter. So even a hand-crafted
   request (devtools / edited markup / a stale cart) is refused at submit time,
   regardless of which page or script built the items. Uses the existing
   product_owner_type / product_owner_id fields; no duplicate ownership model. */
function validateResellerOrderOwnership(items, rid) {
    var list = items || [];
    for (var i = 0; i < list.length; i++) {
        var it = list[i] || {};
        var pid = (it.productId !== undefined && it.productId !== null) ? it.productId : it.product_id;
        var p = findProductById(pid);
        if (!p) return { ok: false, message: '"' + (it.name || 'Product') + '" পাওয়া যায়নি — order করা যাবে না।' };
        if (productOwnerType(p) === 'reseller' && !isResellerOwnProduct(p, rid)) {
            return { ok: false, message: '"' + (p.name || it.name || 'Product') + '" আপনার account-এর product নয় — order করা যাবে না।' };
        }
    }
    return { ok: true };
}
/* Out of Stock list for the reseller panel — variant aware and ownership safe. */
function resellerOutOfStockProducts(rid) {
    var list = resellerSelectableProducts(rid), out = [];
    for (var i = 0; i < list.length; i++) if (isOutOfStock(list[i])) out.push(list[i]);
    return out;
}

/* ---------- order line items — single source of truth --------------------- */
function orderLineItems(o) {
    if (!o) return [];
    if (o.items && o.items.length) return o.items;
    /* Single-product legacy row -> one synthetic line. `resale` / `selling_price`
       are carried so the historical customer price survives on old orders. */
    return [{
        productId: o.productId, name: o.productName || 'Product', qty: Number(o.qty) || 1,
        price: o.productPrice, resale: o.resale, selling_price: o.selling_price,
        cost: o.productCost, buy_price: o.buy_price, cost_price: o.cost_price,
        size: o.size, color: o.color, variant: o.variant, image: o.image,
        product_source: o.product_source,
        product_owner_type: o.product_owner_type, product_owner_id: o.product_owner_id,
        ownerResellerId: o.product_owner_id
    }];
}
function orderTimeMs(o) {
    if (!o) return 0;
    var t = Date.parse(o.createdAt || '');
    if (isNaN(t)) t = Date.parse(o.date || '');
    return isNaN(t) ? 0 : t;
}
/* Historical CUSTOMER-FACING selling price captured when the order was placed. */
function itemSellingPrice(it) {
    if (!it) return 0;
    var v = it.selling_price;
    if (v !== undefined && v !== null && v !== '') return Number(v) || 0;
    if (it.resale) return Number(it.resale) || 0;
    if (it.customer_price) return Number(it.customer_price) || 0;
    var p = findProductById(it.productId);
    if (p && Number(p.customer_price) > 0) return Number(p.customer_price) || 0;
    return Number(it.price) || 0;
}
/* Historical BUYING / COST price. Internal only — never used for any print. */
function itemCostPrice(it) {
    if (!it) return 0;
    var v = it.cost_price;
    if (v !== undefined && v !== null && v !== '') return Number(v) || 0;
    if (it.cost) return Number(it.cost) || 0;
    if (it.buy_price) return Number(it.buy_price) || 0;
    var p = findProductById(it.productId);
    if (p && Number(p.cost) > 0) return Number(p.cost) || 0;
    return Number(it.price) || 0;
}
/* Print-safe projection: name / qty / variant / SELLING price only.
   No cost, no buying price, no supplier price, no profit, no commission. */
function orderPrintItems(o) {
    var items = orderLineItems(o), out = [];
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        var q = Number(it.qty) || 1, sp = itemSellingPrice(it);
        out.push({
            name: String(it.name || 'Product'),
            variant: [it.size, it.color, it.variant].filter(function (x) { return !!x; }).join(' / '),
            qty: q, price: sp, subtotal: sp * q
        });
    }
    return out;
}
function orderPrintTotal(o) {
    var items = orderPrintItems(o), t = 0;
    for (var i = 0; i < items.length; i++) t += items[i].subtotal;
    return t;
}

/* ---------- own-product profit (#13 - #17) -------------------------------- */

/* MY SHOP ORDERS — OWN-LINE PROJECTION (single source of truth)
   A My Shop order may be MIXED: the customer bought the reseller's own product
   together with an admin/supplier product. The reseller must only ever SEE and
   PRINT their own products on this page — never the admin/supplier lines.
   These helpers are the one place that decides which lines those are. Never
   surface the ORDER's items[] directly on a reseller-facing My Shop surface. */
function orderOwnLineItems(o, rid) {
    var items = orderLineItems(o), out = [];
    for (var i = 0; i < items.length; i++) {
        if (itemBelongsToReseller(items[i], rid)) out.push(items[i]);
    }
    return out;
}
/* Product / item counters that match the projected own lines. */
function ownProductCount(o, rid) { return orderOwnLineItems(o, rid).length; }
function ownItemCount(o, rid) {
    var items = orderOwnLineItems(o, rid), n = 0;
    for (var i = 0; i < items.length; i++) n += (Number(items[i].qty) || 1);
    return n;
}
/* Size / color / variant summary built from the own lines only. */
function ownVariantSummary(o, rid) {
    var items = orderOwnLineItems(o, rid);
    var sizes = {}, colors = {}, others = {};
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {}, q = Number(it.qty) || 1;
        var sz = String(it.size || '').trim();
        var cl = String(it.color || '').trim();
        var vr = String(it.variant || '').trim();
        if (sz) sizes[sz] = (sizes[sz] || 0) + q;
        if (cl) colors[cl] = (colors[cl] || 0) + q;
        if (vr) others[vr] = (others[vr] || 0) + q;
    }
    return { sizes: sizes, colors: colors, variants: others };
}
/* Print rows for the OWN lines only — the My Shop invoice must never contain an
   admin/supplier product, and its total must be the own price subtotal. */
function orderOwnPrintItems(o, rid) {
    var items = orderOwnLineItems(o, rid), out = [];
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        var q = Number(it.qty) || 1, sp = itemSellingPrice(it);
        out.push({
            name: String(it.name || 'Product'),
            variant: [it.size, it.color, it.variant].filter(function (x) { return !!x; }).join(' / '),
            qty: q, price: sp, subtotal: sp * q,
            /* 2026-09-18 — the unified invoice sheet needs the picture, the code
               and an explicit customer price. `retail` is set so the sheet never
               re-derives a different number from the product record. */
            retail: sp,
            productId: (it.productId === undefined || it.productId === null) ? '' : it.productId,
            image: rhInvLineImage(it),
            sku: rhInvLineSku(it)
        });
    }
    return out;
}
function orderOwnPrintTotal(o, rid) {
    var items = orderOwnPrintItems(o, rid), t = 0;
    for (var i = 0; i < items.length; i++) t += items[i].subtotal;
    return t;
}

function profitEligibleOrder(o) {
    if (!o) return false;
    var s = String(o.status || '').toLowerCase();
    if (s === 'cancelled' || s === 'cancel' || s === 'rejected' || s === 'failed' ||
        s === 'returned' || s === 'refunded' || s === 'unpaid') return false;
    return true;
}
function itemBelongsToReseller(it, rid) {
    if (!it) return false;
    var t = String(it.product_owner_type || it.productOwnerType || '');
    var id = (it.product_owner_id !== undefined && it.product_owner_id !== null) ? it.product_owner_id : it.ownerResellerId;
    if (t === 'reseller') return String(id) === String(rid);
    if (id !== undefined && id !== null && id !== '' && t !== 'admin' && t !== 'supplier') return String(id) === String(rid);
    var p = findProductById(it.productId);
    return !!(p && isResellerOwnProduct(p, rid));
}
/* Profit of ONE order, counting ONLY this reseller's own uploaded products. */
function ownProductProfitOf(o, rid) {
    if (!profitEligibleOrder(o)) return 0;
    var items = orderLineItems(o), total = 0;
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        if (!itemBelongsToReseller(it, rid)) continue;
        var q = Number(it.qty) || 1;
        total += (itemSellingPrice(it) - itemCostPrice(it)) * q;
    }
    return total;
}
function ownProductProfitStats(rid) {
    var list = resellerOwnProductOrders(rid);
    var now = new Date(), t0 = startOfTodayMs(), DAY = 86400000;
    var m1 = new Date(now.getTime()); m1.setMonth(m1.getMonth() - 1);
    var m6 = new Date(now.getTime()); m6.setMonth(m6.getMonth() - 6);
    var y1 = new Date(now.getTime()); y1.setFullYear(y1.getFullYear() - 1);
    var out = { today: 0, yesterday: 0, week: 0, month: 0, six: 0, year: 0, total: 0, orders: 0 };
    var seen = {};
    for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (!o || seen[String(o.id)]) continue;      /* never count an order twice */
        seen[String(o.id)] = 1;
        /* Cancelled / returned / failed never enter the dashboard at all — not
           even as an order count. */
        if (!profitEligibleOrder(o)) continue;
        /* (#9) On a mixed-source order the own-side profit reflects the shared
           delivery adjustment; a single-source order is unchanged. */
        var pf = (orderIsMixedSource(o, rid)) ? ownGroupNetProfit(o, rid) : ownProductProfitOf(o, rid);
        var ms = orderTimeMs(o);
        out.total += pf;
        out.orders++;
        if (ms >= t0) out.today += pf;
        else if (ms >= t0 - DAY && ms < t0) out.yesterday += pf;
        if (ms >= t0 - 6 * DAY) out.week += pf;
        if (ms >= m1.getTime()) out.month += pf;
        if (ms >= m6.getTime()) out.six += pf;
        if (ms >= y1.getTime()) out.year += pf;
    }
    return out;
}

/* ---------- Street First (Steadfast) reseller accounts (#5, #6) -----------
   Storage: server-side through the backend proxy when one is configured
   (preferred — the browser never keeps the keys at all in that mode);
   otherwise obfuscated at rest. Secrets are NEVER returned to a page: only
   sfAccountPublic() (masked) reaches the UI.                                */
function sfSaltKey() {
    try {
        var k = localStorage.getItem('rh_sf_salt');
        if (!k) { k = 'rh' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('rh_sf_salt', k); }
        return k;
    } catch (e) { return 'rh-fallback-salt'; }
}
function _sfObf(s) {
    s = String(s === undefined || s === null ? '' : s);
    if (!s) return '';
    var k = sfSaltKey(), out = '';
    for (var i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ k.charCodeAt(i % k.length));
    try { return btoa(unescape(encodeURIComponent(out))); } catch (e) { return out; }
}
function _sfDeobf(s) {
    s = String(s === undefined || s === null ? '' : s);
    if (!s) return '';
    var raw = '';
    try { raw = decodeURIComponent(escape(atob(s))); } catch (e) { raw = s; }
    var k = sfSaltKey(), out = '';
    for (var i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ k.charCodeAt(i % k.length));
    return out;
}
function sfStorageMode() { return sfProxyUrl() ? 'server' : 'local'; }
function sfAccountsAll() {
    var a = getOne(DB_KEYS.SF_ACCOUNTS);
    return (a && typeof a === 'object') ? a : {};
}
/* INTERNAL — never call from a page. */
function sfAccountOf(rid) {
    var all = sfAccountsAll(), a = all[String(rid)];
    if (!a) return null;
    return {
        apiKey: _sfDeobf(a.apiKey || ''), secret: _sfDeobf(a.secret || ''),
        savedAt: a.savedAt || '', testedAt: a.testedAt || '', connected: a.connected !== false,
        serverSaved: a.serverSaved === true
    };
}
function sfMaskKey(k) {
    k = String(k || '');
    if (k.length <= 6) return k ? '••••' : '';
    return k.slice(0, 3) + '••••••••' + k.slice(-3);
}
/* UI-safe view: masked key only. */
function sfAccountPublic(rid) {
    var a = sfAccountOf(rid);
    if (!a || !a.apiKey) return { connected: false, masked: '', savedAt: '', testedAt: '', storage: sfStorageMode() };
    return {
        connected: a.connected !== false && !!a.secret, masked: sfMaskKey(a.apiKey),
        savedAt: a.savedAt, testedAt: a.testedAt, storage: sfStorageMode(),
        serverSaved: a.serverSaved === true
    };
}
/* cb(err, {serverSaved}) — optional. */
function sfSaveAccount(rid, apiKey, secret, cb) {
    apiKey = String(apiKey || '').trim();
    secret = String(secret || '').trim();
    if (!apiKey || !secret) return false;
    var all = sfAccountsAll(), prev = all[String(rid)] || {};
    all[String(rid)] = {
        apiKey: _sfObf(apiKey), secret: _sfObf(secret),
        savedAt: new Date().toISOString(), testedAt: prev.testedAt || '',
        connected: true, serverSaved: false
    };
    setData(DB_KEYS.SF_ACCOUNTS, all);
    try { logActivity('sf_connect', 'Reseller #' + rid + ' connected a Street First account (' + sfStorageMode() + ')'); } catch (e) {}
    var px = sfProxyUrl();
    if (!px) { if (cb) cb(null, { serverSaved: false }); return true; }
    /* Server mode: hand the keys to the backend ONCE so they never ride along
       with every later request. The local copy stays obfuscated as a fallback. */
    try {
        fetch(px, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sf_save', resellerId: String(rid), apiKey: apiKey, secret: secret })
        }).then(function (r) { return r.json(); }).then(function (j) {
            var ok = !!j && (j.status === 200 || j.connected === true);
            if (ok) {
                var a2 = sfAccountsAll();
                if (a2[String(rid)]) { a2[String(rid)].serverSaved = true; setData(DB_KEYS.SF_ACCOUNTS, a2); }
            }
            if (cb) cb(null, { serverSaved: ok, response: j });
        }).catch(function (e) { if (cb) cb(e); });
    } catch (e) { if (cb) cb(e); }
    return true;
}
function sfDisconnectAccount(rid) {
    var all = sfAccountsAll();
    delete all[String(rid)];
    setData(DB_KEYS.SF_ACCOUNTS, all);
    var px = sfProxyUrl();
    if (px) {
        try {
            fetch(px, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'sf_delete', resellerId: String(rid) })
            }).catch(function () {});
        } catch (e) {}
    }
    try { logActivity('sf_disconnect', 'Reseller #' + rid + ' disconnected the Street First account'); } catch (e) {}
    return true;
}
function sfMarkTested(rid, ok) {
    var all = sfAccountsAll();
    if (!all[String(rid)]) return;
    all[String(rid)].testedAt = new Date().toISOString();
    all[String(rid)].connected = !!ok;
    setData(DB_KEYS.SF_ACCOUNTS, all);
}
function sfAccountConnected(rid) {
    var a = sfAccountOf(rid);
    return !!(a && a.apiKey && a.secret && a.connected !== false);
}

/* ---------- My Shop -> Street First shipment (#7 - #10) ------------------- */
/* Every rule is enforced here, before any request leaves the browser. */
function sfResellerShipCheck(o, rid) {
    if (!o) return { ok: false, reason: 'Order পাওয়া যায়নি।' };
    if (!sfAccountConnected(rid)) return { ok: false, reason: 'আগে নিজের Street First account connect করুন।' };
    var mine = String(o.resellerId) === String(rid) || String(o.shop_id) === String(rid) || String(o.reseller_id) === String(rid);
    if (!mine) return { ok: false, reason: 'এই order আপনার My Shop-এর নয়।' };
    if (!orderHasOwnProduct(o, rid)) return { ok: false, reason: 'এই order-এ আপনার own product নেই — নিজের account দিয়ে পাঠানো যাবে না।' };
    var existing = shipParcelId(o);
    if (existing) return { ok: false, duplicate: true, parcelId: existing, reason: 'এই order already পাঠানো হয়েছে (ID: ' + existing + ')।' };
    var s = String(o.status || '').toLowerCase();
    if (s === 'cancelled' || s === 'cancel' || s === 'returned' || s === 'rejected') {
        return { ok: false, reason: 'Order status "' + (o.status || '') + '" — shipment eligible নয়।' };
    }
    return { ok: true };
}
function sfResellerPayload(o, rid) {
    var items = orderLineItems(o), total = 0;
    for (var i = 0; i < items.length; i++) total += itemSellingPrice(items[i]) * (Number(items[i].qty) || 1);
    return {
        invoice: String(o.id),
        recipient_name: o.customer || '',
        recipient_phone: String(o.phone || '').replace(/\D/g, ''),
        recipient_address: o.address || '',
        cod_amount: Number(o.amount) || total,
        note: 'My Shop order ' + o.id
    };
}
/* Persists the REAL identifiers returned by the API. Never invents an ID. */
function sfSaveResellerShipment(oid, rid, res) {
    var c = (res && res.consignment) ? res.consignment : (res || {});
    var consignment = String(c.consignment_id || c.consignmentId || (res && res.consignment_id) || '');
    var tracking = String(c.tracking_code || c.trackingCode || (res && res.tracking_code) || '');
    var parcel = String(c.parcel_id || c.parcelId || (res && res.parcel_id) || consignment || '');
    if (!consignment && !parcel) return null;

    var orders = getData(DB_KEYS.ORDERS) || [], updated = null;
    for (var i = 0; i < orders.length; i++) {
        if (String(orders[i].id) !== String(oid)) continue;
        var o = orders[i];
        o.shipping_status = 'steadfast_created';
        o.steadfast_consignment_id = consignment;
        o.steadfast_parcel_id = parcel;
        o.steadfast_tracking_code = tracking;
        o.steadfast_created_at = new Date().toISOString();
        o.steadfast_source = 'reseller_own';
        o.steadfast_account_rid = String(rid);
        /* keep the legacy field in sync so existing admin/reseller views work */
        o.steadfastConsignment = consignment;
        o.consignment_id = consignment;
        try { o.steadfast_response = JSON.stringify(res).substring(0, 4000); } catch (e) { o.steadfast_response = ''; }
        var st = String(o.status || '');
        if (st === 'new' || st === 'pending' || st === 'confirmed' || st === 'packaging') o.status = 'shipped';
        updated = o;
        break;
    }
    if (updated) setData(DB_KEYS.ORDERS, orders);
    return updated;
}
/* action: 'create' | 'test'. cb(err, json) */
function sfResellerCall(rid, action, body, cb) {
    var acc = sfAccountOf(rid);
    if (!acc || !acc.apiKey || !acc.secret) { cb(new Error('NO_ACCOUNT')); return; }
    var px = sfProxyUrl();
    /* Through the proxy we use the per-reseller actions; direct calls keep the
       plain Steadfast endpoints. */
    var act = px ? (action === 'test' ? 'sf_test' : 'sf_create') : action;
    var payload = { action: act, resellerId: String(rid) };
    for (var k in body) { if (Object.prototype.hasOwnProperty.call(body, k)) payload[k] = body[k]; }
    try {
        if (px) {
            /* Server-side store: when the proxy already holds this reseller's
               keys we only tell it WHICH account to use, so the secrets never
               travel again. Falls back to sending them if that push failed. */
            if (!acc.serverSaved) { payload.apiKey = acc.apiKey; payload.secret = acc.secret; }
            fetch(px, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
                .then(function (r) { return r.json(); }).then(function (j) { cb(null, j); }).catch(function (e) { cb(e); });
            return;
        }
        if (action === 'test') {
            fetch('https://check.steadfast.com.bd/api/v1/fraud', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Api-Key': acc.apiKey, 'Secret-Key': acc.secret },
                body: JSON.stringify({ api_key: acc.apiKey, secret_key: acc.secret, customer_phone_number: '01700000000' })
            }).then(function (r) { return r.json(); }).then(function (j) { cb(null, j); }).catch(function (e) { cb(e); });
            return;
        }
        fetch('https://portal.steadfast.com.bd/api/v1/create_order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Api-Key': acc.apiKey, 'Secret-Key': acc.secret },
            body: JSON.stringify(body.order || {})
        }).then(function (r) { return r.json(); }).then(function (j) { cb(null, j); }).catch(function (e) { cb(e); });
    } catch (e) { cb(e); }
}
function sfResellerTest(rid, cb) {
    sfResellerCall(rid, 'test', {}, function (err, j) {
        var ok = !err && !!j && (j.status === 200 || j.status === 400 || j.status === 404 || !!j.data || !!j.total_delivered);
        if (!err && j && (j.status === 401 || j.status === 403)) ok = false;
        sfMarkTested(rid, ok);
        cb(err, ok ? j : null, ok);
    });
}
function sfResellerSend(rid, o, cb) {
    var chk = sfResellerShipCheck(o, rid);
    if (!chk.ok) { cb(new Error(chk.reason), null, chk); return; }
    sfResellerCall(rid, 'create', { order: sfResellerPayload(o, rid) }, function (err, j) {
        if (err) { cb(err, null, chk); return; }
        var upd = sfSaveResellerShipment(o.id, rid, j);
        if (!upd) {
            cb(new Error('Steadfast response-এ কোনো Parcel/Consignment ID পাওয়া যায়নি — কোনো fake ID সেভ করা হয়নি।'), j, chk);
            return;
        }
        try { addTracking(o.id, 'Shipped', 'Street First', 'Consignment ID: ' + shipParcelId(upd)); } catch (e) {}
        cb(null, upd, chk);
    });
}
/* Sequential on purpose: each order gets a real response before the next call,
   so a failure can never be mistaken for a success. */
function sfResellerSendBatch(rid, list, cb) {
    var i = 0, okN = 0, failN = 0, errors = [];
    (function next() {
        if (i >= list.length) { cb(null, { ok: okN, fail: failN, errors: errors }); return; }
        var o = list[i++];
        sfResellerSend(rid, o, function (err, upd, chk) {
            if (err) { failN++; errors.push({ id: o && o.id, reason: err.message || String(err) }); }
            else okN++;
            next();
        });
    })();
}

/* ==========================================================================
   MULTI-COURIER ACCOUNTS + BOOKING   (2026-09-19 — this request)
   --------------------------------------------------------------------------
   The user: "রিসেলাররা যাতে যে কোনো কুরিয়ারের এপিআই বা সিক্রেট কি ইউজ করে …
   স্ট্রিট ফাস্ট, পেপার ফ্লাই, রেডএক্স … সেই কুরিয়ারের সাথে কানেক্ট করে
   অর্ডারগুলোকে একসাথে বুক করতে পারে।"

   A reseller may now hold an account with ANY courier, and book her own My Shop
   orders to the connected one in a single action.

   ADDITIVE ON PURPOSE — nothing above this line was changed:
     · new storage keys rh_courier_accounts / rh_courier_active, so DB_VERSION
       stays '5' and no existing record is touched.
     · STEADFAST keeps the PROVEN sf* path. Connecting Steadfast here also calls
       sfSaveAccount(), and booking on Steadfast delegates to
       sfResellerSendBatch() — so the existing flow is byte-for-byte unchanged.
     · every other courier uses the generic path below.

   HONESTY RULE (same one sfSaveResellerShipment already follows): a parcel /
   consignment id is stored ONLY when the courier's API really returned one.
   No id is ever invented, so a failed booking can never read as a success.
   ========================================================================== */

/* The couriers offered in the picker. `base` is an editable default — the
   reseller can point any of them at the endpoint their own courier dashboard
   gives them, and can add a courier that is not listed via 'other'.
   `auth` selects how the key/secret are attached (see rhCourierHeaders). */
var RH_COURIERS = [
    { id: 'steadfast', name: 'Steadfast Courier',
      desc: 'Nationwide — Inside Dhaka 60৳, Outside 120৳',
      base: 'https://portal.steadfast.com.bd/api/v1/create_order',
      auth: 'key_secret_headers' },
    { id: 'pathao', name: 'Pathao Courier',
      desc: 'City & countryside delivery',
      base: '', auth: 'bearer_key' },
    { id: 'paperfly', name: 'Paperfly',
      desc: 'Doorstep delivery in 64 districts',
      base: '', auth: 'key_secret_body' },
    { id: 'redx', name: 'RedX',
      desc: 'Nationwide parcel delivery',
      base: '', auth: 'apikey_header' },
    { id: 'other', name: 'Other Courier',
      desc: 'Connect any other courier with its own API Key / Secret Key',
      base: '', auth: 'key_secret_headers' }
];
function rhCourierDef(id) {
    for (var i = 0; i < RH_COURIERS.length; i++) if (RH_COURIERS[i].id === String(id)) return RH_COURIERS[i];
    return null;
}
function rhCourierName(id) { var d = rhCourierDef(id); return d ? d.name : String(id || ''); }
/* Every scheme below is a standard HTTP auth shape, not a guess about a
   particular vendor: the reseller picks the courier and the endpoint, and this
   only decides where the key goes. */
function rhCourierAuthStyles() {
    return [
        { id: 'key_secret_headers', label: 'Api-Key + Secret-Key headers' },
        { id: 'apikey_header', label: 'API-Key header (key only)' },
        { id: 'bearer_key', label: 'Authorization: Bearer <key>' },
        { id: 'key_secret_body', label: 'Key + Secret in the JSON body' }
    ];
}
function rhCourierAccountsAll() {
    var a = getOne(DB_KEYS.COURIER_ACCOUNTS);
    return (a && typeof a === 'object') ? a : {};
}
/* INTERNAL — never call from a page (returns the real secret). */
function rhCourierAccountOf(rid, cid) {
    var all = rhCourierAccountsAll();
    var mine = all[String(rid)];
    if (!mine || typeof mine !== 'object') return null;
    var a = mine[String(cid)];
    if (!a) return null;
    return {
        apiKey: _sfDeobf(a.apiKey || ''), secret: _sfDeobf(a.secret || ''),
        base: a.base || '', auth: a.auth || 'key_secret_headers',
        label: a.label || '', savedAt: a.savedAt || '', testedAt: a.testedAt || '',
        connected: a.connected !== false, serverSaved: a.serverSaved === true
    };
}
/* UI-safe view: masked key only, never the secret. */
function rhCourierAccountPublic(rid, cid) {
    var a = rhCourierAccountOf(rid, cid);
    var def = rhCourierDef(cid);
    if (!a || !a.apiKey) {
        return { connected: false, masked: '', savedAt: '', testedAt: '', label: '',
                 base: def ? def.base : '', auth: def ? def.auth : 'key_secret_headers',
                 storage: sfStorageMode() };
    }
    return {
        connected: a.connected !== false && !!a.secret, masked: sfMaskKey(a.apiKey),
        savedAt: a.savedAt, testedAt: a.testedAt, storage: sfStorageMode(),
        serverSaved: a.serverSaved === true, label: a.label,
        base: a.base || (def ? def.base : ''), auth: a.auth
    };
}
function rhCourierConnected(rid, cid) {
    /* Steadfast is the one courier with a proven implementation: defer to it so
       the two stores can never disagree. */
    if (String(cid) === 'steadfast') return sfAccountConnected(rid);
    var a = rhCourierAccountOf(rid, cid);
    return !!(a && a.apiKey && a.secret && a.connected !== false);
}
function rhCourierSaveAccount(rid, cid, apiKey, secret, base, auth, label, cb) {
    apiKey = String(apiKey || '').trim();
    secret = String(secret || '').trim();
    if (!apiKey || !secret) return false;
    var all = rhCourierAccountsAll();
    var mine = (all[String(rid)] && typeof all[String(rid)] === 'object') ? all[String(rid)] : {};
    var prev = mine[String(cid)] || {};
    mine[String(cid)] = {
        apiKey: _sfObf(apiKey), secret: _sfObf(secret),
        base: String(base || '').trim(), auth: String(auth || 'key_secret_headers'),
        label: String(label || '').trim(),
        savedAt: new Date().toISOString(), testedAt: prev.testedAt || '',
        connected: true, serverSaved: false
    };
    all[String(rid)] = mine;
    if (setData(DB_KEYS.COURIER_ACCOUNTS, all) === false) return false;
    /* Steadfast is mirrored into the original store so my-shop-orders.html and
       every sf* helper keep seeing it exactly as before. */
    if (String(cid) === 'steadfast') { try { sfSaveAccount(rid, apiKey, secret); } catch (e) {} }
    try { logActivity('courier_connect', 'Reseller #' + rid + ' connected ' + rhCourierName(cid) + ' (' + sfStorageMode() + ')'); } catch (e) {}
    if (cb) cb(null, { serverSaved: false });
    return true;
}
function rhCourierDisconnect(rid, cid) {
    var all = rhCourierAccountsAll();
    if (all[String(rid)] && all[String(rid)][String(cid)]) {
        delete all[String(rid)][String(cid)];
        setData(DB_KEYS.COURIER_ACCOUNTS, all);
    }
    if (String(cid) === 'steadfast') { try { sfDisconnectAccount(rid); } catch (e) {} }
    /* never leave a stale "active" pointer at a courier that is gone */
    if (rhCourierActiveId(rid) === String(cid)) rhCourierSetActive(rid, '');
    try { logActivity('courier_disconnect', 'Reseller #' + rid + ' disconnected ' + rhCourierName(cid)); } catch (e) {}
    return true;
}
function rhCourierActiveId(rid) {
    var m = getOne(DB_KEYS.COURIER_ACTIVE);
    if (!m || typeof m !== 'object') return '';
    return String(m[String(rid)] || '');
}
function rhCourierSetActive(rid, cid) {
    var m = getOne(DB_KEYS.COURIER_ACTIVE);
    if (!m || typeof m !== 'object') m = {};
    if (cid) m[String(rid)] = String(cid); else delete m[String(rid)];
    setData(DB_KEYS.COURIER_ACTIVE, m);
    return true;
}
/* Which courier this reseller books to: the one they picked, else the only one
   they have connected. Returns '' when nothing is connected. */
function rhCourierActiveOrDefault(rid) {
    var a = rhCourierActiveId(rid);
    if (a && rhCourierConnected(rid, a)) return a;
    var all = rhCourierAccountsAll(), mine = all[String(rid)];
    if (mine && typeof mine === 'object') {
        for (var i = 0; i < RH_COURIERS.length; i++) {
            if (mine[RH_COURIERS[i].id] && rhCourierConnected(rid, RH_COURIERS[i].id)) return RH_COURIERS[i].id;
        }
    }
    if (sfAccountConnected(rid)) return 'steadfast';
    return '';
}
function rhCourierHeaders(def, acc) {
    var h = { 'Content-Type': 'application/json' }, a = (def && def.auth) || 'key_secret_headers';
    if (a === 'key_secret_headers') { h['Api-Key'] = acc.apiKey; h['Secret-Key'] = acc.secret; }
    else if (a === 'apikey_header') { h['API-Key'] = acc.apiKey; }
    else if (a === 'bearer_key') { h['Authorization'] = 'Bearer ' + acc.apiKey; }
    return h;
}
/* One request for any non-Steadfast courier. action = 'test' | 'create'.
   cb(err, json). The proxy (when configured) is used in preference, exactly
   like the Steadfast path, so a deployment that already runs it can implement
   the courier handshake server-side. */
function rhCourierCall(rid, cid, action, body, cb) {
    var def = rhCourierDef(cid);
    var acc = rhCourierAccountOf(rid, cid);
    if (!acc || !acc.apiKey) { cb(new Error('NO_ACCOUNT')); return; }
    var px = sfProxyUrl();
    if (px) {
        var payload = { action: 'courier_' + action, courier: String(cid), resellerId: String(rid) };
        if (acc.base) payload.base = acc.base;
        if (acc.auth) payload.auth = acc.auth;
        for (var k in body) { if (Object.prototype.hasOwnProperty.call(body, k)) payload[k] = body[k]; }
        /* the server may hold the keys already; only send them if it does not */
        if (!acc.serverSaved) { payload.apiKey = acc.apiKey; payload.secret = acc.secret; }
        try {
            fetch(px, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
                .then(function (r) { return r.json(); }).then(function (j) { cb(null, j); }).catch(function (e) { cb(e); });
        } catch (e) { cb(e); }
        return;
    }
    var base = String(acc.base || (def ? def.base : '') || '').trim();
    if (!base) {
        cb(new Error('NO_ENDPOINT: এই কুরিয়ারের API endpoint দেওয়া হয়নি। Courier account-এ API URL বসিয়ে Update করুন।'));
        return;
    }
    var hdr = rhCourierHeaders(def ? { auth: acc.auth || def.auth } : null, acc);
    var send = (action === 'test')
        ? { api_key: acc.apiKey, secret_key: acc.secret }
        : (body && body.order) || {};
    if ((acc.auth || (def && def.auth)) === 'key_secret_body') {
        send = {};
        for (var k2 in ((body && body.order) || {})) { if (Object.prototype.hasOwnProperty.call((body && body.order) || {}, k2)) send[k2] = body.order[k2]; }
        send.api_key = acc.apiKey; send.secret_key = acc.secret;
    }
    try {
        fetch(base, { method: 'POST', headers: hdr, body: JSON.stringify(send) })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (j) { cb(null, j); })
            .catch(function (e) { cb(e); });
    } catch (e) { cb(e); }
}
function rhCourierMarkTested(rid, cid, ok) {
    var all = rhCourierAccountsAll();
    if (!all[String(rid)] || !all[String(rid)][String(cid)]) return;
    all[String(rid)][String(cid)].testedAt = new Date().toISOString();
    all[String(rid)][String(cid)].connected = !!ok;
    setData(DB_KEYS.COURIER_ACCOUNTS, all);
    if (String(cid) === 'steadfast') { try { sfMarkTested(rid, ok); } catch (e) {} }
}
function rhCourierTest(rid, cid, cb) {
    if (!rhCourierConnected(rid, cid)) { cb(new Error('NO_ACCOUNT'), null, false); return; }
    if (String(cid) === 'steadfast') { sfResellerTest(rid, cb); return; }
    rhCourierCall(rid, cid, 'test', {}, function (err, j) {
        var ok = !err && !!j && !(j.status === 401 || j.status === 403);
        rhCourierMarkTested(rid, cid, ok);
        cb(err, ok ? j : null, ok);
    });
}
/* The payload a courier expects for a booking. Same field names the Steadfast
   path already sends, so one shape serves every courier. */
function rhCourierPayload(o, rid, cid) {
    var p = sfResellerPayload(o, rid);
    p.courier = String(cid);
    return p;
}
/* Persists ONLY ids the courier really returned. Never invents one. */
function rhCourierSaveShipment(oid, rid, cid, res) {
    if (String(cid) === 'steadfast') return sfSaveResellerShipment(oid, rid, res);
    var c = (res && res.data) ? res.data : (res || {});
    var parcel = String(c.parcel_id || c.parcelId || c.tracking_id || c.trackingId || '');
    var consignment = String(c.consignment_id || c.consignmentId || c.order_id || c.orderId || '');
    var tracking = String(c.tracking_code || c.trackingCode || c.tracking_id || c.trackingId || '');
    if (!parcel && !consignment && !tracking) return null;   /* nothing real came back */

    var orders = getData(DB_KEYS.ORDERS) || [], updated = null;
    for (var i = 0; i < orders.length; i++) {
        if (String(orders[i].id) !== String(oid)) continue;
        var o = orders[i];
        o.courier = rhCourierName(cid);
        o.courier_id = String(cid);
        o.courier_parcel_id = parcel;
        o.courier_consignment_id = consignment;
        o.courier_tracking_code = tracking;
        o.courier_created_at = new Date().toISOString();
        o.courier_source = 'reseller_own';
        o.courier_account_rid = String(rid);
        /* shipping_status marks "a real booking exists", and consignment_id is
           the generic field shipParcelId() already reads. The steadfast_* fields
           are deliberately NOT written here — this booking is not Steadfast. */
        o.shipping_status = 'courier_created';
        o.consignment_id = consignment || parcel;
        if (tracking) o.trackingId = tracking;
        try { o.courier_response = JSON.stringify(res).substring(0, 4000); } catch (e) { o.courier_response = ''; }
        var st = String(o.status || '');
        if (st === 'new' || st === 'pending' || st === 'confirmed' || st === 'packaging') o.status = 'shipped';
        updated = o;
        break;
    }
    if (updated) setData(DB_KEYS.ORDERS, orders);
    return updated;
}
/* Every rule (ownership, own product present, duplicate, status) is the SAME
   sfResellerShipCheck() the Steadfast flow uses — the courier is only an extra
   condition on top, so privacy can not differ between couriers. */
function rhCourierShipCheck(o, rid, cid) {
    var chk = sfResellerShipCheck(o, rid);
    if (!chk.ok) return chk;
    if (o && o.courier_consignment_id && String(o.courier_id || '') !== String(cid)) {
        return { ok: false, duplicate: true, parcelId: o.courier_consignment_id,
                 reason: 'এই order already ' + rhCourierName(o.courier_id) + '-এ পাঠানো হয়েছে।' };
    }
    return { ok: true };
}
function rhCourierBookOne(rid, cid, o, cb) {
    if (String(cid) === 'steadfast') { sfResellerSend(rid, o, cb); return; }
    var chk = rhCourierShipCheck(o, rid, cid);
    if (!chk.ok) { cb(new Error(chk.reason), null, chk); return; }
    rhCourierCall(rid, cid, 'create', { order: rhCourierPayload(o, rid, cid) }, function (err, j) {
        if (err) { cb(err, null, chk); return; }
        var upd = rhCourierSaveShipment(o.id, rid, cid, j);
        if (!upd) {
            cb(new Error(rhCourierName(cid) + '-এর response-এ কোনো Parcel/Tracking ID পাওয়া যায়নি — কোনো fake ID সেভ করা হয়নি।'), j, chk);
            return;
        }
        try { addTracking(o.id, 'Shipped', rhCourierName(cid), 'Consignment ID: ' + (upd.courier_consignment_id || upd.courier_parcel_id)); } catch (e) {}
        cb(null, upd, chk);
    });
}
/* Sequential on purpose, exactly like sfResellerSendBatch: each order gets a
   real response before the next call, so one failure can never be read as a
   success and the courier is not hammered with parallel requests. */
function rhCourierBookBatch(rid, cid, list, cb) {
    if (String(cid) === 'steadfast') { sfResellerSendBatch(rid, list, cb); return; }
    var i = 0, okN = 0, failN = 0, errors = [];
    (function next() {
        if (i >= list.length) { cb(null, { ok: okN, fail: failN, errors: errors }); return; }
        var o = list[i++];
        rhCourierBookOne(rid, cid, o, function (err) {
            if (err) { failN++; errors.push({ id: o && o.id, reason: err.message || String(err) }); }
            else okN++;
            next();
        });
    })();
}

/* ==========================================================================
   ADMIN MULTI-COURIER   (2026-09-19 — this request)
   --------------------------------------------------------------------------
   The user: "স্ট্রিট ফার্স্ট কুরিয়ার ছাড়াও যাতে যেকোনো কুরিয়ার পেপার ফ্লাই, রেড এক্স
   এগুলো যাতে অ্যাডমিন কানেক্ট করতে পারে … অন্য কুরিয়ারে সব অর্ডারগুলো দিতে পারে একসাথে।"

   The ADMIN's courier credentials are the PLATFORM's own account, so unlike the
   reseller's they live in rh_settings rather than in a per-reseller key:
       settings.courier_accounts = { <cid>: { apiKey, secret, base, auth, savedAt } }
       settings.courier_active   = '<cid>'
   STEADFAST IS MIRRORED into the legacy sf_api_key / sf_secret_key, so every
   existing Steadfast code path (fraud check, settings, printing) is untouched.
   The courier list is the SAME RH_COURIERS registry the reseller panel uses.
   ========================================================================== */
function rhAdminCourierAccounts() {
    var s = getOne(DB_KEYS.SETTINGS);
    if (!s || typeof s !== 'object') return {};
    var a = s.courier_accounts;
    return (a && typeof a === 'object') ? a : {};
}
function rhAdminCourierAccount(cid) {
    var a = rhAdminCourierAccounts()[String(cid)];
    if (!a) return null;
    return {
        apiKey: String(a.apiKey || ''), secret: String(a.secret || ''),
        base: String(a.base || ''), auth: String(a.auth || 'key_secret_headers'),
        savedAt: a.savedAt || ''
    };
}
function rhAdminCourierSave(cid, apiKey, secret, base, auth) {
    cid = String(cid || 'steadfast');
    var s = getOne(DB_KEYS.SETTINGS);
    if (!s || typeof s !== 'object') s = {};
    var a = (s.courier_accounts && typeof s.courier_accounts === 'object') ? s.courier_accounts : {};
    var def = rhCourierDef(cid);
    a[cid] = {
        apiKey: String(apiKey || '').trim(), secret: String(secret || '').trim(),
        base: String(base || '').trim() || (def ? def.base : ''),
        auth: String(auth || '').trim() || (def ? def.auth : 'key_secret_headers'),
        savedAt: new Date().toISOString()
    };
    s.courier_accounts = a;
    if (!s.courier_active) s.courier_active = cid;
    /* Steadfast stays mirrored, so the proven Steadfast paths never change */
    if (cid === 'steadfast') {
        s.sf_api_key = a[cid].apiKey;
        s.sf_secret_key = a[cid].secret;
    }
    setData(DB_KEYS.SETTINGS, s);
    return true;
}
function rhAdminCourierActive() {
    var s = getOne(DB_KEYS.SETTINGS);
    var c = (s && typeof s === 'object') ? String(s.courier_active || '') : '';
    return c || 'steadfast';
}
function rhAdminCourierSetActive(cid) {
    var s = getOne(DB_KEYS.SETTINGS);
    if (!s || typeof s !== 'object') s = {};
    s.courier_active = String(cid || 'steadfast');
    setData(DB_KEYS.SETTINGS, s);
    return true;
}
function rhAdminCourierConnected(cid) {
    var a = rhAdminCourierAccount(cid);
    return !!(a && a.apiKey);
}
/* ONE booking call for the admin's ACTIVE courier. cb(err, json).
   Uses the configured proxy when there is one (the same contract the Steadfast
   path already uses), otherwise calls that courier's own endpoint directly.
   Returns NO_ENDPOINT rather than pretending, when a courier has no endpoint. */
function rhAdminCourierBook(order, cb) {
    var cid = rhAdminCourierActive();
    var acc = rhAdminCourierAccount(cid);
    var def = rhCourierDef(cid);
    if (!acc || !acc.apiKey) { cb(new Error('NO_ACCOUNT')); return; }
    var s = getOne(DB_KEYS.SETTINGS) || {};
    var px = String(s.sf_proxy || '').trim();
    if (px) {
        try {
            fetch(px, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'courier_create', courier: cid, order: order,
                    apiKey: acc.apiKey, secretKey: acc.secret, base: acc.base, auth: acc.auth
                })
            }).then(function (r) { return r.json(); }).then(function (j) { cb(null, j); }).catch(function (e) { cb(e); });
        } catch (e) { cb(e); }
        return;
    }
    var base = String(acc.base || (def ? def.base : '') || '').trim();
    if (!base) { cb(new Error('NO_ENDPOINT')); return; }
    var auth = acc.auth || (def ? def.auth : 'key_secret_headers');
    var hdr = rhCourierHeaders({ auth: auth }, acc);
    var body = order;
    if (auth === 'key_secret_body') {
        body = {};
        for (var k in order) { if (Object.prototype.hasOwnProperty.call(order, k)) body[k] = order[k]; }
        body.api_key = acc.apiKey; body.secret_key = acc.secret;
    }
    try {
        fetch(base, { method: 'POST', headers: hdr, body: JSON.stringify(body) })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (j) { cb(null, j); }).catch(function (e) { cb(e); });
    } catch (e) { cb(e); }
}
/* the courier a booking response should be attributed to */
function rhAdminCourierName() { return rhCourierName(rhAdminCourierActive()); }
/* Which id the booking response actually belongs to, so a page never labels a
   Paperfly booking "Steadfast". */
function rhAdminCourierBookedId() { return rhAdminCourierActive(); }

/* Stock may only move for products the reseller actually owns — an admin or
   supplier product line never touches anyone else's inventory. */
function applyOwnProductStockDeduction(o, rid) {
    var items = orderLineItems(o);
    if (!items.length) return 0;
    var ps = getData(DB_KEYS.PRODUCTS) || [], changed = 0;
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        if (!itemBelongsToReseller(it, rid)) continue;
        for (var j = 0; j < ps.length; j++) {
            if (String(ps[j].id) !== String(it.productId)) continue;
            if (!isResellerOwnProduct(ps[j], rid)) break;
            deductVariantStock(ps[j], it.size || '', it.color || '', Number(it.qty) || 1);
            changed++;
            break;
        }
    }
    if (changed) setData(DB_KEYS.PRODUCTS, ps);
    return changed;
}

/* ==========================================================================
   PREMIUM PLAN — the lock system (2026-09-18)
   --------------------------------------------------------------------------
   Four My Shop features sit behind premium:
       Shop Settings  ·  My Products  ·  My Shop Orders  ·  Customer Messages
   NOTHING else changes. A free reseller still sells, takes orders and earns
   commission exactly as before, and their My Shop stays live for customers —
   only the MANAGEMENT of it is locked.

   House rules obeyed here:
     * ADDITIVE ONLY — one new key (rh_premium). DB_VERSION stays '5'.
     * ONE canonical query, premiumState(), decides everything. No page filters
       the lock by hand.
     * Driven from app.js rather than from each page's markup, so all 27
       reseller pages obey the same rule and a page added later cannot forget
       it. Same pattern as rhApplyShopUploadPolicy().
     * Fails CLOSED: if the state cannot be read we lock rather than give away
       a paid feature. Money correctness beats convenience here.
   ========================================================================== */
var PREMIUM_KEY = 'rh_premium';
var PREMIUM_PRICE = 1000;                       /* ৳ — shown in the popup */
var PREMIUM_WA_NUMBER = '8801997904792';        /* wa.me target */
var PREMIUM_WA_LABEL = '+880 1997-904792';
var PREMIUM_DAY_MS = 86400000;

/* The four locked features. `file` is the sidebar href; matching is done on the
   filename only, so an absolute or relative href both work. */
var PREMIUM_LOCKED = [
    { file: 'my-shop-settings.html', label: 'Shop Settings' },
    { file: 'my-products.html', label: 'My Products' },
    { file: 'my-shop-orders.html', label: 'My Shop Orders' },
    { file: 'customer-messages.html', label: 'Customer Messages' },
    /* 2026-09-18 — Customer Information is a premium feature too: the address book
       and the one-click ordering are part of what premium pays for. Listed here so
       the sidebar badge, the click-block and the page guard all pick it up with no
       further code. */
    { file: 'customer-information.html', label: 'Customer Information' },
    /* 2026-09-18 (this request) — Shop Categories: building your own category tree
       is a management feature, exactly like the other four. The reader was already
       premium-aware (getOwnCategories() returns [] while a shop is lapsed); this
       makes the PAGE itself lock, so the reseller is told rather than shown an
       empty tree. */
    { file: 'shop-categories.html', label: 'Shop Categories' }
];

/* What premium unlocks — written once, used by the popup and the admin page.
   2026-09-18 — the DOMAIN benefit goes FIRST on purpose: the user asked for it to
   be the headline ("মেইনলি আগে বলবা"). It is real, not a promise: My Shop Settings
   already carries a `domain` field, and that page is one of the four locked ones. */
var PREMIUM_BENEFITS = [
    { icon: 'fa-globe', title: 'নিজের ডোমেইন যুক্ত করুন',
      note: 'আপনার কেনা ডোমেইন (যেমন yourshop.com) সরাসরি My Shop-এ কানেক্ট করুন — নিজের ব্র্যান্ডে নিজের দোকান' },
    { icon: 'fa-sliders', title: 'My Shop Settings', note: 'থিম, রঙ, লোগো, ব্যানার, ডেলিভারি ও রিটার্ন পলিসি — সব নিজের মতো সাজান' },
    { icon: 'fa-box-open', title: 'My Products', note: 'নিজের প্রোডাক্ট আপলোড, এডিট, দাম ও স্টক কন্ট্রোল' },
    { icon: 'fa-bag-shopping', title: 'My Shop Orders', note: 'কাস্টমারের অর্ডার দেখা, কনফার্ম ও ডেলিভারি প্রসেস' },
    { icon: 'fa-comment-dots', title: 'Customer Messages', note: 'কাস্টমারের সাথে সরাসরি চ্যাট — বিক্রি বাড়ে' },
    { icon: 'fa-truck-fast', title: 'Steadfast কুরিয়ার', note: 'অর্ডার সরাসরি কুরিয়ারে পাঠান, নিজের একাউন্টে' },
    { icon: 'fa-chart-line', title: 'Pixel কানেক্ট', note: 'Facebook, Instagram, YouTube ও TikTok পিক্সেল' }
];

/* ---------------------------------------------------------------- the store */

function premiumStore() {
    var s = getOne(PREMIUM_KEY);
    if (!s || typeof s !== 'object' || Object.prototype.toString.call(s) === '[object Array]') s = {};
    if (!s.trial || typeof s.trial !== 'object') s.trial = {};
    if (typeof s.trial.enabled !== 'boolean') s.trial.enabled = false;
    if (!(Number(s.trial.days) > 0)) s.trial.days = 7;
    if (typeof s.trial.since !== 'string') s.trial.since = '';
    /* How long the OFFER itself runs, separate from how many days each reseller
       gets. '' means the offer never ends. e.g. "run it for 20 days, then new
       sign-ups stop getting the 7 days". */
    if (typeof s.trial.offerUntil !== 'string') s.trial.offerUntil = '';
    if (typeof s.trial.offerDays !== 'number') s.trial.offerDays = 0;   /* 0 = unlimited */
    if (!s.excluded || typeof s.excluded !== 'object') s.excluded = {};
    if (!s.rec || typeof s.rec !== 'object') s.rec = {};
    return s;
}
function premiumSave(s) { return setData(PREMIUM_KEY, s); }

/* A read-only view of one reseller's record — never mutates the store. */
function premiumRecOf(s, rid) {
    var r = (s && s.rec && s.rec[String(rid)]) ? s.rec[String(rid)] : null;
    if (!r || typeof r !== 'object') {
        return { claimed: false, claimedAt: '', trialEndsAt: '', premiumUntil: '', grant: null, history: [] };
    }
    return {
        claimed: !!r.claimed,
        claimedAt: String(r.claimedAt || ''),
        trialEndsAt: String(r.trialEndsAt || ''),
        premiumUntil: String(r.premiumUntil || ''),
        grant: (r.grant && typeof r.grant === 'object') ? r.grant : null,
        history: Object.prototype.toString.call(r.history) === '[object Array]' ? r.history : []
    };
}
/* Days left, rounded UP, so "expires tomorrow" reads as 1 and never as 0. */
function premiumDaysLeft(iso) {
    if (!iso) return 0;
    var t = Date.parse(iso);
    if (isNaN(t)) return 0;
    var ms = t - Date.now();
    return ms <= 0 ? 0 : Math.ceil(ms / PREMIUM_DAY_MS);
}
function premiumActive(iso) { return premiumDaysLeft(iso) > 0; }
function premiumIso(ms) { try { return new Date(ms).toISOString(); } catch (e) { return ''; } }

function premiumResellerById(rid) {
    try {
        var list = getData(DB_KEYS.RESELLERS) || [];
        var want = String(rid);
        for (var i = 0; i < list.length; i++) {
            if (list[i] && String(list[i].id) === want) return list[i];
        }
    } catch (e) { }
    return null;
}

/* ==========================================================================
   APPROVAL GATE FOR THE FREE TRIAL  (2026-09-18, this request)
   --------------------------------------------------------------------------
   A reseller who registers sits at status 'pending' until the admin approves
   them. They may log in, browse products and look at their My Shop — but the
   one-time free trial is not theirs to take yet: a pending account is precisely
   the one the admin has not vetted.

   So a claim requires status === 'approved'. Anything else — pending, rejected,
   banned, or an id we cannot even find — counts as NOT approved. The gate fails
   CLOSED, because what sits behind it is free premium access.

   The claim BUTTON is deliberately still shown (the user asked for that): the
   reseller may press it, and is then handed a ready-written WhatsApp message
   asking the admin to approve them. Hiding the button would leave them guessing
   why nothing works. The admin's own hand-picked grant (premiumGrantTrial) is
   untouched and still works for any reseller, approved or not.

   `premiumTrialEligible()` is deliberately NOT changed: `premiumState().canClaim`
   stays true, so the badge and the popup still invite the reseller — the refusal
   happens at the moment of claiming, where the explanation can be given.
   ========================================================================== */
function premiumResellerApproved(rid) {
    try {
        var r = premiumResellerById(rid);
        if (!r) return false;                        /* unknown => not approved */
        return String(r.status || '').toLowerCase() === 'approved';
    } catch (e) { return false; }
}
function premiumResellerPending(rid) { return !premiumResellerApproved(rid); }

/* The message the reseller sends the admin when they try to claim too early.
   Opens WhatsApp with it already written, so they only have to press send. */
function premiumApprovalWhatsAppUrl(rid) {
    var who = '';
    try {
        var r = premiumResellerById(rid);
        if (r) who = String(r.businessName || r.name || '');
    } catch (e) { }
    return premiumWhatsAppUrl(
        'আসসালামু আলাইকুম। আমার ResellerHub অ্যাকাউন্ট' + (who ? ' (' + who + ')' : '') +
        ' এখনো অ্যাপ্রুভ হয়নি, তাই ফ্রি ট্রায়াল ক্লেইম করতে পারছি না। ' +
        'অনুগ্রহ করে আমার অ্যাকাউন্টটি অ্যাপ্রুভ করে দিন — অ্যাপ্রুভ হলেই আমি ফ্রি ট্রায়াল নিতে পারব। ধন্যবাদ।');
}

/* A reseller is offered the one-time trial when:
     * the admin has the trial switched ON,
     * they are not on the exclude list, and
     * they registered AFTER the trial was switched on (new sign-ups only).
   A record the admin granted by hand (`grant`) is eligible regardless, which is
   how "pick a reseller myself and give them a trial" works. */
function premiumTrialEligible(rid, s) {
    try {
        s = s || premiumStore();
        var rec = premiumRecOf(s, rid);
        if (rec.grant && Number(rec.grant.days) > 0) return true;      /* hand-picked */
        if (!s.trial.enabled) return false;
        /* the offer itself may have expired — after that, new sign-ups get nothing */
        if (s.trial.offerUntil) {
            var end = Date.parse(s.trial.offerUntil);
            if (!isNaN(end) && Date.now() > end) return false;
        }
        if (s.excluded && s.excluded[String(rid)]) return false;
        if (s.trial.since) {
            var r = premiumResellerById(rid);
            var joined = r ? Date.parse(r.joinDate || r.createdAt || '') : NaN;
            if (!isNaN(joined) && joined < Date.parse(s.trial.since)) return false;
        }
        return true;
    } catch (e) { return false; }
}

/* THE canonical query. level is one of:
     'premium'    — a paid, unexpired period
     'trial'      — an unexpired free trial
     'claimable'  — eligible for the one-time trial, not claimed yet
     'locked'     — no access
   `open` is the convenience flag every caller should use. */
function premiumState(rid) {
    var out = { level: 'locked', open: false, daysLeft: 0, endsAt: '', canClaim: false,
                trialDays: 0, premiumDays: 0, granted: false, pending: false };
    try {
        var s = premiumStore();
        var rec = premiumRecOf(s, rid);
        if (rec.grant && Number(rec.grant.days) > 0) out.granted = true;
        /* 2026-09-18 — is this account still waiting for the admin to approve it?
           The popup reads this to explain why a claim is refused instead of just
           failing. It does NOT affect `open`/`canClaim`. */
        out.pending = premiumResellerPending(rid);

        if (premiumActive(rec.premiumUntil)) {
            out.level = 'premium'; out.open = true;
            out.endsAt = rec.premiumUntil; out.daysLeft = premiumDaysLeft(rec.premiumUntil);
            out.premiumDays = out.daysLeft;
            return out;
        }
        if (premiumActive(rec.trialEndsAt)) {
            out.level = 'trial'; out.open = true;
            out.endsAt = rec.trialEndsAt; out.daysLeft = premiumDaysLeft(rec.trialEndsAt);
            out.trialDays = out.daysLeft;
            return out;
        }
        if (!rec.claimed && premiumTrialEligible(rid, s)) {
            out.level = 'claimable'; out.canClaim = true;
            out.trialDays = (rec.grant && Number(rec.grant.days) > 0)
                ? Number(rec.grant.days) : (Number(s.trial.days) || 7);
            return out;
        }
        out.level = 'locked';
        return out;
    } catch (e) { return out; }        /* fail CLOSED */
}
/* Is THIS browser session a locked reseller? The one question the UI asks. */
function premiumLockedForSession() {
    try {
        if (sessionStorage.getItem('user_type') !== 'reseller') return false;   /* admin/supplier never locked */
        var uid = sessionStorage.getItem('user_id');
        if (!uid) return false;
        var st = premiumState(uid);
        return !st.open;
    } catch (e) { return false; }
}
function premiumSessionState() {
    try {
        if (sessionStorage.getItem('user_type') !== 'reseller') return null;
        var uid = sessionStorage.getItem('user_id');
        if (!uid) return null;
        return premiumState(uid);
    } catch (e) { return null; }
}

/* ------------------------------------------------------------------ writers */

/* The reseller claims their one-time trial. The clock starts HERE — never at
   the moment the admin granted it, so a reseller who claims late loses nothing. */
function premiumClaim(rid) {
    try {
        var s = premiumStore();
        var rec = premiumRecOf(s, rid);
        /* 2026-09-18 — the approval gate comes FIRST: an account the admin has not
           approved cannot take the trial at all. `pending:true` tells the caller to
           send them to WhatsApp rather than show a bare error. */
        if (premiumResellerPending(rid)) {
            return { ok: false, pending: true,
                     message: 'আপনার অ্যাকাউন্ট এখনো অ্যাডমিন অ্যাপ্রুভ করেননি, তাই ফ্রি ট্রায়াল ক্লেইম করা যাবে না।\n\n' +
                              'অ্যাডমিন অ্যাপ্রুভ করে দিলেই এখান থেকেই ট্রায়াল নিতে পারবেন — ট্রায়াল জীবনে একবারই পাওয়া যায়।' };
        }
        if (rec.claimed) return { ok: false, message: 'ফ্রি ট্রায়াল আগেই নেওয়া হয়েছে — এটা একবারই পাওয়া যায়।' };
        if (!premiumTrialEligible(rid, s)) return { ok: false, message: 'আপনি ফ্রি ট্রায়ালের জন্য যোগ্য নন।' };

        var days = (rec.grant && Number(rec.grant.days) > 0) ? Number(rec.grant.days) : (Number(s.trial.days) || 7);
        var k = String(rid);
        if (!s.rec[k] || typeof s.rec[k] !== 'object') s.rec[k] = {};
        s.rec[k].claimed = true;
        s.rec[k].claimedAt = new Date().toISOString();
        s.rec[k].trialEndsAt = premiumIso(Date.now() + days * PREMIUM_DAY_MS);
        s.rec[k].grant = null;
        if (Object.prototype.toString.call(s.rec[k].history) !== '[object Array]') s.rec[k].history = [];
        s.rec[k].history.push({ type: 'trial', days: days, at: s.rec[k].claimedAt, by: 'self' });

        if (premiumSave(s) === false) return { ok: false, message: 'সেভ করা যায়নি — স্টোরেজ ভরে গেছে।' };
        return { ok: true, days: days, until: s.rec[k].trialEndsAt };
    } catch (e) { return { ok: false, message: 'কিছু একটা ভুল হয়েছে।' }; }
}

/* Admin: grant a trial to a hand-picked reseller. It is CLAIMABLE, so the days
   do not burn before they actually use it. */
function premiumGrantTrial(rid, days) {
    try {
        var n = Math.max(1, parseInt(days, 10) || 0);
        if (!n) return false;
        var s = premiumStore();
        var k = String(rid);
        if (!s.rec[k] || typeof s.rec[k] !== 'object') s.rec[k] = {};
        /* 2026-09-18 — BUG FIX: this used to refuse when `claimed` was already
           true, so once a reseller had taken a trial the admin could NEVER give
           them another one. "One per lifetime" is the limit on the reseller's own
           self-claim; the owner must always be able to hand one out. So an admin
           grant clears the used flag and re-arms it. */
        s.rec[k].claimed = false;
        s.rec[k].trialEndsAt = '';
        s.rec[k].grant = { days: n, at: new Date().toISOString(), source: 'admin' };
        if (Object.prototype.toString.call(s.rec[k].history) !== '[object Array]') s.rec[k].history = [];
        s.rec[k].history.push({ type: 'trial-grant', days: n, at: new Date().toISOString(), by: 'admin' });
        return premiumSave(s) !== false;
    } catch (e) { return false; }
}

/* 2026-09-19 — OFFER REWARD: free-trial days that ADD to whatever is left.
   ---------------------------------------------------------------------------
   Deliberately NOT the same as premiumGrantTrial() above, which is an admin
   RE-ARMING the one-time trial and therefore REPLACES it. A reward must never
   take days away: a reseller with 25 days left who claims a 10-day offer ends up
   with 35, not 10.

   The clock also starts AFTER any PAID premium. premiumState() checks
   `premiumUntil` first, so days somebody paid for are never eaten by a free
   trial running underneath them — the trial begins when the paid period ends.

   This is a REWARD, not the reseller's one-time self-claim, so `claimed` is left
   alone: earning a trial must not burn their own claim. */
function premiumGrantTrialDays(rid, days) {
    try {
        var n = Math.max(1, parseInt(days, 10) || 0);
        if (!n) return false;
        var s = premiumStore();
        var k = String(rid);
        if (!s.rec[k] || typeof s.rec[k] !== 'object') s.rec[k] = {};
        var rec = s.rec[k];

        /* the later of: now, a running trial, a running paid period */
        var base = Date.now();
        var t = Date.parse(rec.trialEndsAt || '');
        if (!isNaN(t) && t > base) base = t;
        var p = Date.parse(rec.premiumUntil || '');
        if (!isNaN(p) && p > base) base = p;

        rec.trialEndsAt = new Date(base + n * PREMIUM_DAY_MS).toISOString();
        if (Object.prototype.toString.call(rec.history) !== '[object Array]') rec.history = [];
        rec.history.push({ type: 'offer-reward-trial', days: n, at: new Date().toISOString(), by: 'offer' });
        if (premiumSave(s) === false) return false;
        return { ok: true, days: n, endsAt: rec.trialEndsAt };
    } catch (e) { return false; }
}
/* How many whole trial days does this reseller have left (0 when none)? */
function premiumTrialDaysLeft(rid) {
    try {
        var rec = premiumRecOf(premiumStore(), rid);
        if (!rec || !rec.trialEndsAt) return 0;
        return premiumDaysLeft(rec.trialEndsAt);
    } catch (e) { return 0; }
}

/* Admin: wipe the trial state for one reseller so it starts clean — the "remove
   from the trial" button. Paid premium (premiumUntil) is deliberately NOT touched:
   removing a free trial must never take away days somebody paid for. */
function premiumResetTrial(rid) {
    try {
        var s = premiumStore();
        var k = String(rid);
        if (!s.rec[k]) return true;
        s.rec[k].claimed = false;
        s.rec[k].claimedAt = '';
        s.rec[k].trialEndsAt = '';
        s.rec[k].grant = null;
        return premiumSave(s) !== false;
    } catch (e) { return false; }
}

/* Has the global new-registration offer expired? (An offer with no end date
   never expires.) Returns how many whole days are left, or -1 for unlimited. */
function premiumOfferDaysLeft() {
    try {
        var s = premiumStore();
        if (!s.trial.enabled) return 0;
        if (!s.trial.offerUntil) return -1;
        var end = Date.parse(s.trial.offerUntil);
        if (isNaN(end)) return -1;
        var ms = end - Date.now();
        return ms <= 0 ? 0 : Math.ceil(ms / PREMIUM_DAY_MS);
    } catch (e) { return 0; }
}

/* Admin: grant (or extend) premium. STACKS onto whatever is left — a reseller
   with 20 days left who buys another 30 ends up with 50, never 30. */
function premiumGrant(rid, days) {
    try {
        var n = Math.max(1, parseInt(days, 10) || 0);
        if (!n) return false;
        var s = premiumStore();
        var rec = premiumRecOf(s, rid);
        var base = premiumActive(rec.premiumUntil) ? Date.parse(rec.premiumUntil) : Date.now();
        var until = premiumIso(base + n * PREMIUM_DAY_MS);

        var k = String(rid);
        if (!s.rec[k] || typeof s.rec[k] !== 'object') s.rec[k] = {};
        s.rec[k].premiumUntil = until;
        if (Object.prototype.toString.call(s.rec[k].history) !== '[object Array]') s.rec[k].history = [];
        s.rec[k].history.push({ type: 'premium', days: n, at: new Date().toISOString(), until: until, by: 'admin' });

        if (premiumSave(s) === false) return false;
        return true;
    } catch (e) { return false; }
}

/* Admin: remove premium early. */
function premiumRevoke(rid) {
    try {
        var s = premiumStore();
        var k = String(rid);
        if (!s.rec[k]) return true;
        s.rec[k].premiumUntil = '';
        s.rec[k].trialEndsAt = '';
        s.rec[k].grant = null;
        return premiumSave(s) !== false;
    } catch (e) { return false; }
}

/* Admin: the global trial switch. Turning it ON stamps `since`, so only
   registrations from that moment on are eligible. */
/* enabled  — is the new-registration offer on?
   days     — how many days EACH reseller gets
   offerDays— how many days the OFFER runs for. 0 / omitted = unlimited.
              Turning it on (re)starts the offer window, so "run it for 20 days
              then stop" is one setting, not two. */
function premiumSetTrial(enabled, days, offerDays) {
    try {
        var s = premiumStore();
        var was = !!s.trial.enabled;
        s.trial.enabled = !!enabled;
        var n = parseInt(days, 10);
        if (n > 0) s.trial.days = n;

        var od = parseInt(offerDays, 10);
        if (isNaN(od) || od < 0) od = 0;
        s.trial.offerDays = od;
        s.trial.offerUntil = (od > 0) ? premiumIso(Date.now() + od * PREMIUM_DAY_MS) : '';

        if (s.trial.enabled && !was) s.trial.since = new Date().toISOString();
        if (!s.trial.enabled) { s.trial.since = ''; s.trial.offerUntil = ''; s.trial.offerDays = 0; }
        return premiumSave(s) !== false;
    } catch (e) { return false; }
}

/* Admin: exclude / un-exclude one reseller from the automatic trial. */
function premiumSetExcluded(rid, on) {
    try {
        var s = premiumStore();
        var k = String(rid);
        if (on) s.excluded[k] = true; else delete s.excluded[k];
        return premiumSave(s) !== false;
    } catch (e) { return false; }
}

/* The admin list: one row per reseller, already resolved. */
function premiumAll() {
    var rows = [];
    try {
        var s = premiumStore();
        var list = getData(DB_KEYS.RESELLERS) || [];
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            if (!r) continue;
            var st = premiumState(r.id);
            rows.push({
                id: r.id,
                name: String(r.name || r.shopName || r.businessName || ('Reseller #' + r.id)),
                phone: String(r.phone || ''),
                shop: String(r.shopName || r.businessName || ''),
                joined: String(r.joinDate || r.createdAt || ''),
                level: st.level,
                daysLeft: st.daysLeft,
                endsAt: st.endsAt,
                canClaim: st.canClaim,
                excluded: !!(s.excluded && s.excluded[String(r.id)]),
                claimed: premiumRecOf(s, r.id).claimed,
                granted: st.granted,
                history: premiumRecOf(s, r.id).history
            });
        }
    } catch (e) { }
    return rows;
}
/* Search the list by name / shop / phone / id — the admin's picker. */
function premiumFindResellers(q) {
    var needle = String(q || '').trim().toLowerCase();
    var all = premiumAll();
    if (!needle) return all;
    return all.filter(function (r) {
        return String(r.name).toLowerCase().indexOf(needle) !== -1 ||
            String(r.shop).toLowerCase().indexOf(needle) !== -1 ||
            String(r.phone).toLowerCase().indexOf(needle) !== -1 ||
            String(r.id) === needle;
    });
}

/* ==========================================================================
   PREMIUM PLAN — the lock UI
   --------------------------------------------------------------------------
   Driven entirely from here, so all 27 reseller pages behave identically with
   NO per-page edits, and a page added later cannot forget the rule.
   Three jobs:
     rhApplyPremiumLock()  — paint the sidebar badges and block the 4 links
     rhPremiumPopup()      — the animated Bengali upsell
     rhPremiumGuardPage()  — a direct link to one of the 4 pages gets nowhere
   ========================================================================== */

/* --------------------------------------------------------------- utilities */

function premiumWhatsAppUrl(extra) {
    var text = extra || ('আসসালামু আলাইকুম। আমি ResellerHub-এর প্রিমিয়াম প্ল্যান সম্পর্কে জানতে চাই।');
    return 'https://wa.me/' + PREMIUM_WA_NUMBER + '?text=' + encodeURIComponent(text);
}
function premiumFileOf(href) {
    try {
        return String(href || '').split('#')[0].split('?')[0].split('/').pop().toLowerCase();
    } catch (e) { return ''; }
}
function premiumIsLockedFile(file) {
    var f = String(file || '').toLowerCase();
    for (var i = 0; i < PREMIUM_LOCKED.length; i++) if (PREMIUM_LOCKED[i].file === f) return true;
    return false;
}
function premiumLabelForFile(file) {
    var f = String(file || '').toLowerCase();
    for (var i = 0; i < PREMIUM_LOCKED.length; i++) if (PREMIUM_LOCKED[i].file === f) return PREMIUM_LOCKED[i].label;
    return 'এই ফিচার';
}
/* Bengali digits, because the rest of the panel is written in Bengali. */
function premiumBn(n) {
    var en = '0123456789', bn = '০১২৩৪৫৬৭৮৯';
    var s = String(n === undefined || n === null ? '' : n), out = '';
    for (var i = 0; i < s.length; i++) {
        var p = en.indexOf(s.charAt(i));
        out += p === -1 ? s.charAt(i) : bn.charAt(p);
    }
    return out;
}
function premiumMoney(n) {
    try { return premiumBn(String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')); } catch (e) { return premiumBn(n); }
}

/* ------------------------------------------------------------------- styles */

function premiumInjectCss() {
    try {
        if (document.getElementById('rhpmCss')) return;
        var css =
            /* ---- sidebar badge ---- */
            '.rhpm-badge{margin-left:auto;display:inline-flex;align-items:center;gap:4px;font-size:.6rem;font-weight:800;' +
            'padding:2px 7px;border-radius:9px;line-height:1.5;white-space:nowrap;flex-shrink:0}' +
            '.rhpm-badge.lock{background:rgba(251,191,36,.16);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}' +
            '.rhpm-badge.free{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;box-shadow:0 3px 10px rgba(34,197,94,.4)}' +
            '.rhpm-badge.trial{background:rgba(56,189,248,.16);color:#38bdf8;border:1px solid rgba(56,189,248,.3)}' +
            'li.rhpm-li-locked>a{opacity:.92}' +
            'li.rhpm-li-locked>a i:first-child{color:#fbbf24}' +
            /* ---- overlay ---- */
            '.rhpm-ov{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;' +
            'padding:16px;background:rgba(7,10,26,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
            'opacity:0;transition:opacity .28s ease;overflow-y:auto}' +
            '.rhpm-ov.show{opacity:1}' +
            '.rhpm-ov.rhpm-block{background:rgba(7,10,26,.94);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}' +
            /* ---- card ---- */
            '.rhpm-card{position:relative;width:100%;max-width:430px;margin:auto;border-radius:24px;overflow:hidden;' +
            'background:linear-gradient(165deg,#141a38 0%,#0b1029 58%,#171233 100%);' +
            'border:1px solid rgba(129,140,248,.28);box-shadow:0 30px 70px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.04) inset;' +
            'transform:translateY(22px) scale(.96);opacity:0;transition:transform .42s cubic-bezier(.2,.9,.3,1.15),opacity .3s ease}' +
            '.rhpm-ov.show .rhpm-card{transform:none;opacity:1}' +
            '.rhpm-card::before{content:"";position:absolute;top:-120px;left:50%;transform:translateX(-50%);width:340px;height:340px;' +
            'background:radial-gradient(circle,rgba(124,58,237,.34),transparent 68%);pointer-events:none;animation:rhpmGlow 5s ease-in-out infinite}' +
            '@keyframes rhpmGlow{0%,100%{opacity:.75;transform:translateX(-50%) scale(1)}50%{opacity:1;transform:translateX(-50%) scale(1.12)}}' +
            '.rhpm-x{position:absolute;top:12px;right:12px;z-index:3;width:34px;height:34px;border:none;border-radius:11px;cursor:pointer;' +
            'background:rgba(255,255,255,.07);color:#c7d2fe;font-size:1rem;display:flex;align-items:center;justify-content:center;transition:all .2s}' +
            '.rhpm-x:hover{background:#fee2e2;color:#dc2626;transform:rotate(90deg)}' +
            /* ---- header ---- */
            '.rhpm-hd{position:relative;z-index:2;text-align:center;padding:30px 22px 14px}' +
            '.rhpm-crown{width:66px;height:66px;margin:0 auto 14px;border-radius:20px;display:flex;align-items:center;justify-content:center;' +
            'font-size:1.6rem;color:#fff;background:linear-gradient(135deg,#f59e0b,#f43f5e 55%,#a855f7);' +
            'box-shadow:0 14px 34px rgba(244,63,94,.42);animation:rhpmPop .6s cubic-bezier(.2,.9,.3,1.4) both,rhpmFloat 3.4s ease-in-out 0.6s infinite}' +
            '@keyframes rhpmPop{from{transform:scale(.3) rotate(-25deg);opacity:0}to{transform:none;opacity:1}}' +
            '@keyframes rhpmFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}' +
            '.rhpm-hd h2{color:#fff;font-size:1.24rem;font-weight:900;margin:0 0 6px;letter-spacing:.2px}' +
            '.rhpm-hd p{color:#a5b4fc;font-size:.83rem;margin:0;line-height:1.6;font-weight:600}' +
            /* ---- price ---- */
            '.rhpm-price{position:relative;z-index:2;margin:16px 22px 6px;border-radius:16px;padding:13px 16px;text-align:center;' +
            'background:linear-gradient(135deg,rgba(245,158,11,.16),rgba(168,85,247,.16));border:1px solid rgba(245,158,11,.34);' +
            'animation:rhpmUp .5s .18s ease both}' +
            '.rhpm-price b{color:#fff;font-size:1.7rem;font-weight:900;letter-spacing:.5px}' +
            '.rhpm-price b i{font-size:.95rem;font-style:normal;font-weight:800;color:#fcd34d;margin-right:2px}' +
            '.rhpm-price small{display:block;color:#fcd34d;font-size:.72rem;font-weight:800;margin-top:3px;letter-spacing:.3px}' +
            /* ---- benefits ---- */
            '.rhpm-list{position:relative;z-index:2;padding:10px 18px 4px;list-style:none;margin:0}' +
            '.rhpm-list li{display:flex;gap:11px;align-items:flex-start;padding:8px 0;animation:rhpmUp .5s ease both}' +
            '.rhpm-list li .ic{width:32px;height:32px;flex-shrink:0;border-radius:10px;display:flex;align-items:center;justify-content:center;' +
            'font-size:.8rem;color:#fff;background:linear-gradient(135deg,#6366f1,#a855f7);box-shadow:0 5px 14px rgba(99,102,241,.35)}' +
            '.rhpm-list li .tx{flex:1;min-width:0}' +
            '.rhpm-list li b{display:block;color:#e8ebff;font-size:.84rem;font-weight:800;margin-bottom:1px}' +
            '.rhpm-list li span{display:block;color:#8b9bd6;font-size:.72rem;line-height:1.5}' +
            '@keyframes rhpmUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}' +
            /* ---- the two plan options ---- */
            '.rhpm-opts{position:relative;z-index:2;padding:8px 18px 0;display:grid;gap:9px}' +
            '.rhpm-opt{display:flex;align-items:center;gap:11px;padding:12px 14px;border-radius:15px;cursor:pointer;text-align:left;' +
            'background:rgba(255,255,255,.045);border:1px solid rgba(129,140,248,.22);transition:all .22s;width:100%;' +
            'font-family:inherit;animation:rhpmUp .5s .3s ease both}' +
            '.rhpm-opt:hover{background:rgba(99,102,241,.16);border-color:rgba(129,140,248,.5);transform:translateX(3px)}' +
            '.rhpm-opt .ic{width:36px;height:36px;flex-shrink:0;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:.9rem}' +
            '.rhpm-opt.a .ic{background:linear-gradient(135deg,#6366f1,#8b5cf6)}' +
            '.rhpm-opt.b .ic{background:linear-gradient(135deg,#f59e0b,#f43f5e)}' +
            '.rhpm-opt b{display:block;color:#e8ebff;font-size:.85rem;font-weight:800}' +
            '.rhpm-opt span{display:block;color:#8b9bd6;font-size:.7rem;margin-top:1px}' +
            '.rhpm-opt .go{margin-left:auto;color:#818cf8;font-size:.85rem}' +
            /* ---- claim ---- */
            '.rhpm-claim{position:relative;z-index:2;margin:14px 18px 0}' +
            '.rhpm-claim button{width:100%;border:none;cursor:pointer;border-radius:15px;padding:14px;font-family:inherit;' +
            'font-size:.95rem;font-weight:900;color:#052e16;background:linear-gradient(135deg,#4ade80,#22c55e);' +
            'box-shadow:0 12px 28px rgba(34,197,94,.4);transition:all .22s;animation:rhpmPulse 2.4s ease-in-out infinite}' +
            '.rhpm-claim button:hover{transform:translateY(-2px);box-shadow:0 16px 34px rgba(34,197,94,.5)}' +
            '.rhpm-claim button:disabled{opacity:.6;cursor:default;animation:none;transform:none}' +
            '@keyframes rhpmPulse{0%,100%{box-shadow:0 12px 28px rgba(34,197,94,.4)}50%{box-shadow:0 12px 34px rgba(34,197,94,.75)}}' +
            '.rhpm-note{position:relative;z-index:2;margin:9px 18px 0;text-align:center;color:#94a3b8;font-size:.7rem;line-height:1.6}' +
            /* ---- whatsapp ---- */
            '.rhpm-wa{position:relative;z-index:2;margin:14px 18px 0;display:flex;align-items:center;justify-content:center;gap:9px;' +
            'padding:13px;border-radius:15px;text-decoration:none;font-weight:900;font-size:.88rem;color:#fff;' +
            'background:linear-gradient(135deg,#25D366,#128C7E);box-shadow:0 12px 28px rgba(37,211,102,.34);transition:all .22s}' +
            '.rhpm-wa:hover{transform:translateY(-2px);box-shadow:0 16px 34px rgba(37,211,102,.46)}' +
            '.rhpm-wa i{font-size:1.15rem}' +
            '.rhpm-wa small{display:block;font-size:.66rem;font-weight:700;opacity:.9;margin-top:1px}' +
            '.rhpm-ft{position:relative;z-index:2;text-align:center;color:#4c5680;font-size:.66rem;padding:14px 18px 18px;font-weight:700}' +
            /* ---- mobile ---- */
            '@media (max-width:520px){' +
            '.rhpm-ov{padding:10px;align-items:flex-start}' +
            '.rhpm-card{max-width:100%;border-radius:20px;margin:6px auto}' +
            '.rhpm-hd{padding:24px 16px 10px}.rhpm-hd h2{font-size:1.1rem}' +
            '.rhpm-crown{width:56px;height:56px;font-size:1.35rem}' +
            '.rhpm-price{margin:12px 14px 4px}.rhpm-price b{font-size:1.45rem}' +
            '.rhpm-list{padding:8px 14px 2px}.rhpm-list li{padding:6px 0}' +
            '.rhpm-list li .ic{width:28px;height:28px;font-size:.72rem}' +
            '.rhpm-list li b{font-size:.79rem}.rhpm-list li span{font-size:.68rem}' +
            '.rhpm-opts{padding:6px 14px 0}.rhpm-claim{margin:12px 14px 0}.rhpm-note{margin:8px 14px 0}' +
            '.rhpm-wa{margin:12px 14px 0;padding:12px;font-size:.82rem}' +
            '}' +
            '@media (prefers-reduced-motion:reduce){' +
            '.rhpm-card,.rhpm-crown,.rhpm-list li,.rhpm-opts,.rhpm-price,.rhpm-claim button{animation:none !important}' +
            '.rhpm-ov,.rhpm-card{transition:none}}';
        var st = document.createElement('style');
        st.id = 'rhpmCss';
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);

        /* 2026-09-18 — a second, purely decorative layer. Kept separate so the
           working styles above are never touched while tuning the look.
           Everything here is animation only: remove this block and the popup
           still looks and works correctly. */
        var fx =
            /* a slow colour-sweeping bar along the top edge of the card */
            '.rhpm-card::after{content:"";position:absolute;top:0;left:0;right:0;height:3px;pointer-events:none;' +
            'background:linear-gradient(90deg,#f59e0b,#f43f5e,#a855f7,#38bdf8,#f59e0b);background-size:300% 100%;' +
            'animation:rhpmBar 5s linear infinite}' +
            '@keyframes rhpmBar{0%{background-position:0% 0}100%{background-position:300% 0}}' +
            /* ring pulse + sparkles around the crown */
            '.rhpm-crown{position:relative}' +
            '.rhpm-crown::before{content:"";position:absolute;inset:-8px;border-radius:26px;' +
            'border:2px solid rgba(245,158,11,.4);animation:rhpmRing 2.6s ease-out infinite;pointer-events:none}' +
            '@keyframes rhpmRing{0%{transform:scale(.9);opacity:.85}100%{transform:scale(1.4);opacity:0}}' +
            '.rhpm-crown::after{content:"";position:absolute;top:6px;right:8px;width:7px;height:7px;border-radius:50%;' +
            'background:#fff;box-shadow:-36px 14px 0 -2px #fff,4px 38px 0 -3px #fff;' +
            'animation:rhpmTwinkle 2.1s ease-in-out infinite;pointer-events:none}' +
            '@keyframes rhpmTwinkle{0%,100%{opacity:.2;transform:scale(.65)}50%{opacity:1;transform:scale(1.2)}}' +
            /* a light sweep across the price block */
            '.rhpm-price{position:relative;overflow:hidden}' +
            '.rhpm-price::after{content:"";position:absolute;top:0;left:-120%;width:55%;height:100%;' +
            'background:linear-gradient(100deg,transparent,rgba(255,255,255,.3),transparent);' +
            'animation:rhpmShine 3.8s ease-in-out infinite;pointer-events:none}' +
            '@keyframes rhpmShine{0%{left:-120%}55%,100%{left:135%}}' +
            /* benefits: bounce in, then lift on hover */
            '.rhpm-list li{transition:transform .2s,border-radius .2s}' +
            '.rhpm-list li:hover{transform:translateX(4px)}' +
            '.rhpm-list li:hover .ic{transform:scale(1.12) rotate(-6deg)}' +
            '.rhpm-list li .ic{transition:transform .25s cubic-bezier(.2,.9,.3,1.4)}' +
            /* the two plan options */
            '.rhpm-opt:hover .ic{transform:scale(1.1) rotate(6deg)}' +
            '.rhpm-opt .ic{transition:transform .25s cubic-bezier(.2,.9,.3,1.4)}' +
            '.rhpm-opt:hover .go{transform:translateX(4px);color:#c4b5fd}' +
            '.rhpm-opt .go{transition:transform .22s,color .22s}' +
            /* whatsapp shimmer */
            '.rhpm-wa{position:relative;overflow:hidden}' +
            '.rhpm-wa::after{content:"";position:absolute;top:0;left:-110%;width:42%;height:100%;' +
            'background:linear-gradient(100deg,transparent,rgba(255,255,255,.32),transparent);' +
            'animation:rhpmShine 3.2s ease-in-out 0.6s infinite;pointer-events:none}' +
            /* the backdrop gets a soft vignette */
            '.rhpm-ov::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;' +
            'background:radial-gradient(ellipse at center,transparent 35%,rgba(0,0,0,.35) 100%)}' +
            '@media (prefers-reduced-motion:reduce){' +
            '.rhpm-card::after,.rhpm-crown::before,.rhpm-crown::after,.rhpm-price::after,.rhpm-wa::after{animation:none !important}' +
            '.rhpm-list li:hover,.rhpm-list li:hover .ic,.rhpm-opt:hover .ic,.rhpm-opt:hover .go{transform:none}}';
        var st2 = document.createElement('style');
        st2.id = 'rhpmCssFx';
        st2.textContent = fx;
        (document.head || document.documentElement).appendChild(st2);
    } catch (e) { }
}

/* -------------------------------------------------------------------- popup */

/* opts: { reason:'locked'|'claimable', label, blocking:bool } */
function rhPremiumPopup(opts) {
    try {
        var o = opts || {};
        premiumInjectCss();
        var st = premiumSessionState() || { level: 'locked', canClaim: false, trialDays: 0, daysLeft: 0 };
        var canClaim = !!st.canClaim && o.reason !== 'expired';

        var old = document.getElementById('rhpmOv');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var ov = document.createElement('div');
        ov.id = 'rhpmOv';
        ov.className = 'rhpm-ov' + (o.blocking ? ' rhpm-block' : '');

        var h = '';
        h += '<div class="rhpm-card" role="dialog" aria-modal="true" aria-label="প্রিমিয়াম প্ল্যান">';
        if (!o.blocking) h += '<button class="rhpm-x" type="button" aria-label="বন্ধ করুন" onclick="rhPremiumClose()"><i class="fas fa-xmark"></i></button>';

        /* 2026-09-18 — a registered-but-not-yet-approved reseller may still press
           the button; it takes them to WhatsApp with the approval request written.
           The invite is NOT hidden (the user asked for that), it is explained. */
        var pending = !!st.pending;
        h += '<div class="rhpm-hd">';
        h += '<div class="rhpm-crown"><i class="fas fa-crown"></i></div>';
        h += '<h2>' + (pending ? 'অ্যাকাউন্ট এখনো অ্যাপ্রুভ হয়নি'
            : (canClaim ? 'আপনার ফ্রি ট্রায়াল প্রস্তুত!' : 'প্রিমিয়াম আনলক করুন')) + '</h2>';
        h += '<p>' + (pending
            ? 'ফ্রি ট্রায়াল ক্লেইম করার আগে অ্যাডমিনকে আপনার অ্যাকাউন্টটি অ্যাপ্রুভ করতে হবে। নিচের বাটনে চাপলে WhatsApp-এ রেডি মেসেজ নিয়ে যাবে — শুধু পাঠিয়ে দিন।'
            : (canClaim
                ? ('একবার ক্লেইম করলেই ' + premiumBn(st.trialDays) + ' দিনের জন্য সব ফিচার খুলে যাবে।')
                : (o.label ? (o.label + ' প্রিমিয়াম প্ল্যানে পাওয়া যায়।') : 'এই ফিচারটি প্রিমিয়াম প্ল্যানে পাওয়া যায়।'))) + '</p>';
        h += '</div>';

        if (!canClaim && !pending) {
            h += '<div class="rhpm-price"><b><i>৳</i>' + premiumMoney(PREMIUM_PRICE) + '</b>' +
                '<small>মাত্র এই একবার — সারা বছরের জন্য সব ফিচার</small></div>';
        }

        h += '<ul class="rhpm-list">';
        for (var i = 0; i < PREMIUM_BENEFITS.length; i++) {
            var b = PREMIUM_BENEFITS[i];
            h += '<li style="animation-delay:' + (0.2 + i * 0.06).toFixed(2) + 's">' +
                '<span class="ic"><i class="fas ' + b.icon + '"></i></span>' +
                '<span class="tx"><b>' + b.title + '</b><span>' + b.note + '</span></span></li>';
        }
        h += '</ul>';

        if (pending) {
            /* the button stays, but it carries the approval request to WhatsApp
               instead of claiming — the admin has to approve this account first */
            h += '<div class="rhpm-claim"><button type="button" id="rhpmClaimBtn" onclick="rhPremiumDoClaim()">' +
                '<i class="fab fa-whatsapp"></i> WhatsApp-এ অ্যাডমিনের সাথে কথা বলুন</button></div>';
            h += '<div class="rhpm-note">অ্যাডমিন অ্যাপ্রুভ করে দিলে ঠিক এখান থেকেই ফ্রি ট্রায়াল ক্লেইম করতে পারবেন। ' +
                'ট্রায়াল <b>জীবনে একবারই</b> পাওয়া যায় — এখন না নিলে কোনো দিন নষ্ট হবে না।</div>';
        } else if (canClaim) {
            h += '<div class="rhpm-claim"><button type="button" id="rhpmClaimBtn" onclick="rhPremiumDoClaim()">' +
                '<i class="fas fa-gift"></i> ফ্রি ট্রায়াল ক্লেইম করুন (' + premiumBn(st.trialDays) + ' দিন)</button></div>';
            h += '<div class="rhpm-note">ক্লেইম করার দিন থেকে হিসাব শুরু হবে — এখন ক্লেইম না করলে দিন নষ্ট হবে না। ' +
                'এই ট্রায়াল <b>জীবনে একবারই</b> পাওয়া যায়।</div>';
        } else {
            h += '<div class="rhpm-opts">';
            h += '<button type="button" class="rhpm-opt a" onclick="rhPremiumBuy()">' +
                '<span class="ic"><i class="fas fa-globe"></i></span>' +
                '<span><b>Normal Website</b><span>৳' + premiumMoney(PREMIUM_PRICE) + ' — সব ফিচার সহ প্রিমিয়াম</span></span>' +
                '<span class="go"><i class="fas fa-chevron-right"></i></span></button>';
            h += '<button type="button" class="rhpm-opt b" onclick="rhPremiumCustom()">' +
                '<span class="ic"><i class="fas fa-wand-magic-sparkles"></i></span>' +
                '<span><b>Customize Website</b><span>নিজের মতো ডিজাইন — আলোচনা সাপেক্ষে</span></span>' +
                '<span class="go"><i class="fas fa-chevron-right"></i></span></button>';
            h += '</div>';
        }

        h += '<a class="rhpm-wa" href="' + premiumWhatsAppUrl() + '" target="_blank" rel="noopener">' +
            '<i class="fab fa-whatsapp"></i><span>WhatsApp-এ কথা বলুন<small>' + PREMIUM_WA_LABEL + '</small></span></a>';
        h += '<div class="rhpm-ft">ResellerHub Premium · যেকোনো সময় যোগাযোগ করুন</div>';
        h += '</div>';

        ov.innerHTML = h;
        document.body.appendChild(ov);
        try { document.body.style.overflow = 'hidden'; } catch (e) { }
        /* next frame so the transition runs */
        try { requestAnimationFrame(function () { ov.classList.add('show'); }); } catch (e) { ov.classList.add('show'); }
        try { if (!o.blocking) { ov.addEventListener('click', function (ev) { if (ev.target === ov) rhPremiumClose(); }); } } catch (e) { }
        return true;
    } catch (e) { return false; }
}

function rhPremiumClose() {
    try {
        var ov = document.getElementById('rhpmOv');
        if (!ov) return;
        ov.classList.remove('show');
        try { document.body.style.overflow = ''; } catch (e) { }
        setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 260);
    } catch (e) { }
}

function rhPremiumDoClaim() {
    try {
        var uid = sessionStorage.getItem('user_id');
        var btn = document.getElementById('rhpmClaimBtn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> চালু হচ্ছে...'; }
        var r = premiumClaim(uid);
        if (!r.ok) {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-gift"></i> আবার চেষ্টা করুন'; }
            /* 2026-09-18 — the account is not approved yet: open WhatsApp with the
               approval request already written, so the reseller only has to press
               send. The popup has already explained why, so no second alert. */
            if (r.pending) {
                var waUrl = premiumApprovalWhatsAppUrl(uid);
                var win = null;
                try { win = window.open(waUrl, '_blank', 'noopener'); } catch (e) { win = null; }
                if (!win) { try { location.href = waUrl; } catch (e2) { } }
                return;
            }
            try { alert(r.message || 'ক্লেইম করা যায়নি।'); } catch (e) { }
            return;
        }
        /* success — repaint everything and reload so every page agrees */
        rhApplyPremiumLock();
        try { rhPremiumClose(); } catch (e) { }
        try { location.reload(); } catch (e) { }
    } catch (e) { }
}
function rhPremiumBuy() {
    try { window.open(premiumWhatsAppUrl('আসসালামু আলাইকুম। আমি ৳' + PREMIUM_PRICE + ' দিয়ে ResellerHub Premium নিতে চাই।'), '_blank', 'noopener'); }
    catch (e) { try { location.href = premiumWhatsAppUrl(); } catch (e2) { } }
}
function rhPremiumCustom() {
    try {
        var ov = document.getElementById('rhpmOv');
        if (!ov) return;
        var card = ov.querySelector('.rhpm-card');
        if (!card) return;
        var box = card.querySelector('.rhpm-custom');
        if (box) { box.parentNode.removeChild(box); }
        var d = document.createElement('div');
        d.className = 'rhpm-custom';
        d.style.cssText = 'position:relative;z-index:2;margin:0 18px 12px;padding:13px 15px;border-radius:15px;' +
            'background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.32);color:#fcd34d;' +
            'font-size:.78rem;line-height:1.75;font-weight:700;animation:rhpmUp .4s ease both';
        d.innerHTML = '<b style="display:block;color:#fff;font-size:.85rem;margin-bottom:4px">' +
            '<i class="fas fa-wand-magic-sparkles"></i> Customize Website</b>' +
            'আপনার নিজের ডিজাইনে ওয়েবসাইট বানিয়ে দেওয়া হয় — <b>আলোচনা সাপেক্ষে</b>। ' +
            'নিচের WhatsApp বাটনে ক্লিক করে সরাসরি কথা বলুন, আমরা আপনার পছন্দমতো সব সেট করে দেব।';
        var wa = card.querySelector('.rhpm-wa');
        if (wa) card.insertBefore(d, wa); else card.appendChild(d);
        try { d.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e2) { }
    } catch (e) { }
}

/* ----------------------------------------------------------------- the lock */

function rhPremiumBadgeFor(state) {
    if (!state) return '';
    if (state.level === 'premium') return '';
    if (state.level === 'trial') {
        return '<span class="rhpm-badge trial" title="ফ্রি ট্রায়াল চলছে"><i class="fas fa-lock-open"></i> ' +
            premiumBn(state.daysLeft) + ' দিন</span>';
    }
    if (state.level === 'claimable') {
        return '<span class="rhpm-badge free" title="ফ্রি ট্রায়াল নিন"><i class="fas fa-gift"></i> ফ্রি</span>';
    }
    return '<span class="rhpm-badge lock" title="প্রিমিয়াম প্রয়োজন"><i class="fas fa-lock"></i> প্রিমিয়াম</span>';
}

/* Paint the sidebar badges on every reseller page. Never throws, never removes
   anything, and adds nothing at all when the reseller has premium. */
function rhApplyPremiumLock() {
    try {
        if (sessionStorage.getItem('user_type') !== 'reseller') return;
        var uid = sessionStorage.getItem('user_id');
        if (!uid) return;
        premiumInjectCss();
        var st = premiumState(uid);
        var links = document.querySelectorAll('a[href]');
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var file = premiumFileOf(a.getAttribute('href'));
            if (!premiumIsLockedFile(file)) continue;
            /* only inside the panel's own sidebar / bottom nav */
            if (!(a.closest && a.closest('.sidebar,.sidebar-menu,.bottom-nav,.bnav,aside,nav,ul'))) continue;

            var li = a.closest ? a.closest('li') : null;
            /* remove our previous badge so a repaint never stacks two */
            var prev = a.querySelector('.rhpm-badge');
            if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

            var badge = rhPremiumBadgeFor(st);
            if (badge) {
                var span = document.createElement('span');
                span.innerHTML = badge;
                var node = span.firstChild;
                a.appendChild(node);
            }
            if (li) {
                if (st.open) li.classList.remove('rhpm-li-locked');
                else li.classList.add('rhpm-li-locked');
            }
        }
    } catch (e) { /* a lock must never break a page */ }
}

/* Block navigation to the four features for a locked session. Capture phase, so
   nothing else gets a chance to navigate first. */
function rhPremiumInstallClickBlock() {
    try {
        if (window.__rhPmClickBlock) return;
        window.__rhPmClickBlock = true;
        document.addEventListener('click', function (ev) {
            try {
                if (!premiumLockedForSession()) return;
                var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
                if (!a) return;
                var file = premiumFileOf(a.getAttribute('href'));
                if (!premiumIsLockedFile(file)) return;
                ev.preventDefault();
                ev.stopPropagation();
                if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
                var st = premiumSessionState() || {};
                rhPremiumPopup({ reason: st.canClaim ? 'claimable' : 'locked', label: premiumLabelForFile(file) });
            } catch (e) { }
        }, true);
    } catch (e) { }
}

/* A direct link to one of the four pages must get nowhere. The popup covers the
   page and the content behind it is made unreadable and unreachable. */
function rhPremiumGuardPage() {
    try {
        if (sessionStorage.getItem('user_type') !== 'reseller') return;
        var uid = sessionStorage.getItem('user_id');
        if (!uid) return;
        var file = premiumFileOf(location.pathname);
        if (!premiumIsLockedFile(file)) return;
        var st = premiumState(uid);
        if (st.open) return;

        /* hide the real content from view AND from the tab order */
        var nodes = document.querySelectorAll('.main,.wrap,#main,.content,.page-wrap,.container');
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if (n.id === 'rhpmOv') continue;
            n.style.filter = 'blur(9px)';
            n.style.pointerEvents = 'none';
            n.setAttribute('aria-hidden', 'true');
        }
        try { document.documentElement.style.overflow = 'hidden'; } catch (e) { }
        rhPremiumPopup({ reason: st.canClaim ? 'claimable' : 'locked', label: premiumLabelForFile(file), blocking: true });
    } catch (e) { }
}

/* Repaint on a slow timer so a countdown ticks down without a reload, and so an
   admin change made on another device reaches this one. */
function rhPremiumTick() {
    try {
        if (window.__rhPmTick) return;
        window.__rhPmTick = setInterval(function () {
            try {
                if (sessionStorage.getItem('user_type') !== 'reseller') return;
                rhApplyPremiumLock();
                var ov = document.getElementById('rhpmOv');
                if (ov && premiumLockedForSession()) {
                    var st = premiumSessionState() || {};
                    if (st.open) { rhPremiumClose(); location.reload(); }
                }
            } catch (e) { }
        }, 60000);
    } catch (e) { }
}

/* One boot entry point. */
function rhPremiumBoot() {
    try {
        if (sessionStorage.getItem('user_type') !== 'reseller') return;
        rhApplyPremiumLock();
        rhPremiumInstallClickBlock();
        rhPremiumGuardPage();
        rhPremiumTick();
        try {
            window.addEventListener('storage', function (e) {
                if (!e.key || e.key.indexOf('rh_premium') === 0) { try { rhApplyPremiumLock(); } catch (e2) { } }
            });
        } catch (e) { }
    } catch (e) { }
}

/* Add the Premium entry to the ADMIN sidebar on every admin page.
   Every admin page carries its own copy of the nav, so this is done from app.js
   rather than by editing 24 files — the same reasoning as rhApplyPremiumLock().
   Idempotent: if the item is already there (admin/premium.html ships it) nothing
   is added. The current page is highlighted only on premium.html itself. */
function rhInjectAdminPremiumNav() {
    try {
        if (document.getElementById('pmNavItem')) return;
        var menu = document.querySelector('.lx-menu');
        if (!menu) return;
        if (menu.querySelector('a[href="premium.html"]')) return;

        var isHere = (String(location.pathname || '').split('/').pop().toLowerCase() === 'premium.html');
        var label = document.createElement('div');
        label.className = 'sec-label';
        label.textContent = 'Premium';
        var a = document.createElement('a');
        a.href = 'premium.html';
        a.id = 'pmNavItem';
        a.className = 'sb-item' + (isHere ? ' on' : '');
        a.innerHTML = '<span class="sb-ico"><i class="fas fa-crown"></i></span><span class="sb-txt">Premium Plan</span>';
        if (isHere) {
            var lit = menu.querySelectorAll('.sb-item.on');
            for (var i = 0; i < lit.length; i++) lit[i].classList.remove('on');
            a.classList.add('on');
        }
        menu.appendChild(label);
        menu.appendChild(a);
    } catch (e) { /* a nav item must never break a page */ }
}

/* ==========================================================================
   THE "CUSTOMER INFORMATION" SIDEBAR ITEM  (2026-09-18, this request)
   --------------------------------------------------------------------------
   Added from app.js instead of editing 19 HTML files — the same reasoning as
   rhInjectAdminPremiumNav() above, and the same idempotent, never-throws shape.

   RESELLER: the sidebar is a <ul class="sidebar-menu"> of <li><a href="…">…</a></li>.
   The row goes DIRECTLY UNDER "Customer Messages", at the end of the My Shop
   group — the user asked for it there rather than at the very bottom of the panel,
   because it belongs with the other customer-facing pages.

   ADMIN: the sidebar is .lx-menu with .sb-item rows; the row is appended at the
   end with its own section label, exactly like the Premium entry.
   ========================================================================== */
function rhInjectCustomerInfoNav() {
    try {
        if (document.getElementById('ciNavItem')) return;
        var menu = document.querySelector('.sidebar-menu');
        if (!menu) return;                                   /* not a panel page */
        if (menu.querySelector('a[href="customer-information.html"]')) return;
        var here = (String(location.pathname || '').split('/').pop().toLowerCase() === 'customer-information.html');
        var li = document.createElement('li');
        li.id = 'ciNavItem';
        li.innerHTML = '<a href="customer-information.html"' + (here ? ' class="active"' : '') + '>' +
            '<i class="fas fa-address-book"></i> <span>Customer Information</span></a>';
        var kids = menu.children, i, a, href, target = null;
        /* 1 — straight after the "Customer Messages" row */
        for (i = 0; i < kids.length; i++) {
            a = kids[i].querySelector ? kids[i].querySelector('a[href]') : null;
            if (!a) continue;
            if (String(a.getAttribute('href') || '').split('?')[0] === 'customer-messages.html') { target = kids[i]; break; }
        }
        /* insertBefore(li, null) appends, so one line covers "last row" too */
        if (target && target.parentNode === menu) { menu.insertBefore(li, target.nextSibling); return; }
        /* 2 — no Customer Messages row on this page: keep it above the external
              "Visit Site" link, else above Logout, else at the end */
        for (i = 0; i < kids.length; i++) {
            a = kids[i].querySelector ? kids[i].querySelector('a[href]') : null;
            if (!a) continue;
            href = String(a.getAttribute('href') || '');
            if (href.indexOf('../index.html') !== -1) { target = kids[i]; break; }
        }
        if (!target) {
            for (i = 0; i < kids.length; i++) {
                a = kids[i].querySelector ? kids[i].querySelector('a') : null;
                if (!a) continue;
                if (/logout/i.test(String(a.getAttribute('onclick') || '') + ' ' + String(a.getAttribute('href') || ''))) {
                    target = kids[i]; break;
                }
            }
        }
        if (target && target.parentNode === menu) menu.insertBefore(li, target);
        else menu.appendChild(li);
    } catch (e) { /* a nav item must never break a page */ }
}
/* ==========================================================================
   ONE HOME FOR "SHOP CATEGORIES"  (2026-09-19 — NEW home, this request)
   --------------------------------------------------------------------------
   The sidebar is hand-written per page, so the Shop Categories row drifts. It is
   moved HERE, once, from app.js, instead of editing 20 HTML files.

   PREVIOUS home (2026-09-18): the end of the ORDERS group, just above the
   "My Shop" divider. The user has now asked for it to sit under the shop rows
   instead — "মাই শপ অর্ডার্সের নিচে এটাকে রাখো" — so the anchor is now the
   **My Shop Orders row** and the target is the slot directly AFTER it
   (i.e. between "My Shop Orders" and "Customer Messages").

   The source order is the OLD position on all 20 pages, so this normaliser is what
   actually produces the new position at runtime — the HTML files are untouched.

   It MOVES the existing row; it never creates a second one. Idempotent, and a nav
   row must never be able to break a page.
   ========================================================================== */
function rhNormaliseShopCategoriesNav() {
    try {
        var menu = document.querySelector('.sidebar-menu');
        if (!menu) return;
        var kids = menu.children, i, a;
        var row = null, anchor = null;
        for (i = 0; i < kids.length; i++) {
            a = kids[i].querySelector ? kids[i].querySelector('a[href]') : null;
            if (!a) continue;
            if (String(a.getAttribute('href') || '').split('?')[0] === 'shop-categories.html') { row = kids[i]; break; }
        }
        if (!row) return;                                  /* this page has no such row */
        for (i = 0; i < kids.length; i++) {
            a = kids[i].querySelector ? kids[i].querySelector('a[href]') : null;
            if (!a) continue;
            if (String(a.getAttribute('href') || '').split('?')[0] === 'my-shop-orders.html') { anchor = kids[i]; break; }
        }
        if (!anchor) return;                               /* unexpected markup — leave it alone */
        if (row.previousElementSibling === anchor) return;  /* already in the right place */
        /* insertBefore(node, null) appends — so "anchor is the last row" also works */
        menu.insertBefore(row, anchor.nextSibling);
    } catch (e) { /* a nav row must never break a page */ }
}
function rhInjectAdminCustomerInfoNav() {
    try {
        if (document.getElementById('ciAdminNavItem')) return;
        var menu = document.querySelector('.lx-menu');
        if (!menu) return;
        if (menu.querySelector('a[href="customer-information.html"]')) return;
        var isHere = (String(location.pathname || '').split('/').pop().toLowerCase() === 'customer-information.html');
        var label = document.createElement('div');
        label.className = 'sec-label';
        label.textContent = 'Customers';
        var a = document.createElement('a');
        a.href = 'customer-information.html';
        a.id = 'ciAdminNavItem';
        a.className = 'sb-item' + (isHere ? ' on' : '');
        a.innerHTML = '<span class="sb-ico"><i class="fas fa-address-book"></i></span><span class="sb-txt">Customer Information</span>';
        if (isHere) {
            var lit = menu.querySelectorAll('.sb-item.on');
            for (var i = 0; i < lit.length; i++) lit[i].classList.remove('on');
            a.classList.add('on');
        }
        menu.appendChild(label);
        menu.appendChild(a);
    } catch (e) { /* a nav item must never break a page */ }
}
