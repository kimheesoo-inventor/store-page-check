/*
 * Store Page Check - free, open-source, single-page bookmarklet.
 * Reads the page it runs on and loads the store's own policy pages (same site, GET only) to see whether they are empty or still contain template text.
 * No tracking; nothing is sent to the author or any third party.
 * Judgement functions (core) are kept separate from DOM code so they can be unit-tested in Node.
 * License: MIT, Copyright (c) 2026 Heesoo Kim
 */
(function () {
  'use strict';

  var DOCS = {
    misrep: 'https://support.google.com/merchants/answer/6150127',
    editorial: 'https://support.google.com/merchants/answer/6150244',
    listing: 'https://developers.google.com/search/docs/appearance/structured-data/merchant-listing',
images: 'https://developers.google.com/search/docs/appearance/google-images'
  };

  var NOTICE = 'Free, open-source check of this page and the store\'s own policy pages. Not affiliated with Google or Shopify. It does not guarantee Merchant Center approval or reinstatement. Nothing is sent to the author or anyone else.';

  var STATUS_LABEL = { ok: 'OK', check: 'Check', na: 'N/A' };

  /* ---------------- pure helpers (no DOM) ---------------- */

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function asArray(v) { return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]); }

  function hasValue(v) {
    if (v === undefined || v === null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (typeof v === 'number') return !isNaN(v);
    if (Array.isArray(v)) return v.some(hasValue);
    if (isObj(v)) return Object.keys(v).length > 0;
    return !!v;
  }

  function typeList(node) {
    if (!isObj(node)) return [];
    return asArray(node['@type']).map(function (t) {
      return String(t).replace(/^.*[\/#]/, '');
    });
  }
  function hasType(node, name) { return typeList(node).indexOf(name) !== -1; }

  /* Parse list of JSON-LD script texts into flat node list. Handles arrays and @graph. */
  function parseJsonLd(texts) {
    var nodes = [];
    var errors = 0;
    function walk(item, depth) {
      if (depth > 6) return;
      if (Array.isArray(item)) { item.forEach(function (x) { walk(x, depth + 1); }); return; }
      if (!isObj(item)) return;
      nodes.push(item);
      if (item['@graph']) walk(item['@graph'], depth + 1);
    }
    asArray(texts).forEach(function (t) {
      try {
        walk(JSON.parse(String(t).trim()), 0);
      } catch (e) {
        errors += 1;
      }
    });
    return { nodes: nodes, errors: errors };
  }

  /* ---- microdata (itemscope / itemtype / itemprop) ----
   * The DOM part reads the page into a plain tree: { type: 'http://schema.org/Product', props: [{ name, value } | { name, item }] }.
   * microdataToNodes() turns that tree into the same shape JSON-LD gives, so one set of checks serves both formats. */
  var MICRODATA_PRODUCT_RE = /schema\.org\/Product(Group)?(?![A-Za-z0-9])/i;
  function isProductItemtype(t) { return MICRODATA_PRODUCT_RE.test(String(t || '')); }

  function microdataToNodes(items) {
    function conv(it, depth) {
      if (!isObj(it) || depth > 6) return null;
      var types = String(it.type || '').split(/\s+/).filter(Boolean);
      var node = { '@type': types.length === 1 ? types[0] : types };
      asArray(it.props).forEach(function (p) {
        if (!isObj(p) || !p.name) return;
        var v = p.item ? conv(p.item, depth + 1) : (p.value === undefined || p.value === null ? '' : String(p.value));
        if (v === null) return;
        if (Object.prototype.hasOwnProperty.call(node, p.name)) node[p.name] = asArray(node[p.name]).concat([v]);
        else node[p.name] = v;
      });
      return node;
    }
    return asArray(items).map(function (it) { return conv(it, 0); }).filter(Boolean);
  }

  /* Combine a JSON-LD product with a microdata product. JSON-LD wins; gaps are filled from microdata. */
  function mergeProducts(ld, md) {
    if (!ld) return md || null;
    if (!md) return ld;
    var merged = {};
    Object.keys(ld).forEach(function (k) { merged[k] = ld[k]; });
    Object.keys(md).forEach(function (k) {
      if (k !== 'offers' && !hasValue(merged[k]) && hasValue(md[k])) merged[k] = md[k];
    });
    var lo = flattenOffers(ld);
    var mo = flattenOffers(md);
    if (!lo.length) {
      if (mo.length) merged.offers = mo;
    } else if (lo.length === mo.length) {
      merged.offers = lo.map(function (o, i) {
        var r = {};
        Object.keys(o).forEach(function (k) { r[k] = hasValue(o[k]) ? o[k] : mo[i][k]; });
        return r;
      });
    }
    return merged;
  }

  function formatsText(formats) {
    var f = asArray(formats);
    return f.length ? f.join(' + ') : 'none';
  }

  /* Find the Product (or ProductGroup merged with its variants). Returns null if none. */
  function findProduct(nodes) {
    var i;
    for (i = 0; i < nodes.length; i++) {
      if (hasType(nodes[i], 'Product')) return nodes[i];
    }
    for (i = 0; i < nodes.length; i++) {
      if (hasType(nodes[i], 'ProductGroup')) {
        var g = nodes[i];
        var variants = asArray(g.hasVariant).filter(isObj);
        var merged = {};
        Object.keys(g).forEach(function (k) { merged[k] = g[k]; });
        var offers = [];
        variants.forEach(function (v) {
          offers = offers.concat(asArray(v.offers));
          ['name', 'image', 'brand', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'mpn', 'sku'].forEach(function (k) {
            if (!hasValue(merged[k]) && hasValue(v[k])) merged[k] = v[k];
          });
        });
        if (offers.length) merged.offers = offers;
        merged['@type'] = 'Product';
        return merged;
      }
    }
    return null;
  }

  /* Flatten offers: array, single Offer, AggregateOffer (with or without nested offers). */
  function flattenOffers(product) {
    var out = [];
    function add(o, depth) {
      if (!isObj(o) || depth > 4) return;
      if (hasType(o, 'AggregateOffer')) {
        var nested = asArray(o.offers).filter(isObj);
        if (nested.length) {
          nested.forEach(function (n) { add(n, depth + 1); });
          return;
        }
      }
      var spec = isObj(o.priceSpecification) ? o.priceSpecification : (Array.isArray(o.priceSpecification) && isObj(o.priceSpecification[0]) ? o.priceSpecification[0] : {});
      var price = hasValue(o.price) ? o.price : (hasValue(o.lowPrice) ? o.lowPrice : spec.price);
      var cur = hasValue(o.priceCurrency) ? o.priceCurrency : spec.priceCurrency;
      out.push({
        price: price,
        priceCurrency: cur,
        availability: o.availability,
        shippingDetails: o.shippingDetails,
        hasMerchantReturnPolicy: o.hasMerchantReturnPolicy
      });
    }
    if (!isObj(product)) return out;
    asArray(product.offers).forEach(function (o) { add(o, 0); });
    return out;
  }

  /* Parse "$1,299.00", "12,50", "19.99 USD" into a number, or null. */
  function parsePrice(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number') return isNaN(v) ? null : v;
    var s = String(v).replace(/[^0-9.,\-]/g, '');
    if (!/[0-9]/.test(s)) return null;
    if (s.indexOf(',') !== -1 && s.indexOf('.') === -1 && /,\d{1,2}$/.test(s)) {
      s = s.replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function brandName(b) {
    if (typeof b === 'string') return b.trim();
    if (isObj(b)) return typeof b.name === 'string' ? b.name.trim() : '';
    if (Array.isArray(b)) {
      for (var i = 0; i < b.length; i++) { var n = brandName(b[i]); if (n) return n; }
    }
    return '';
  }

  var ID_KEYS = ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'mpn', 'sku'];

  function item(group, id, label, status, reason, ref) {
    return { group: group, id: id, label: label, status: status, reason: reason, ref: ref };
  }

  /* Evaluate Product fields. product may be null. */
  function evaluateProduct(product, pageHint) {
    var G = 'Product data (JSON-LD / microdata)';
    var res = [];
    var fmt = formatsText(pageHint && pageHint.formats);
    if (!product) {
      var looksLikeProduct = !!(pageHint && pageHint.looksLikeProduct);
      res.push(item(G, 'product-jsonld', 'Product structured data',
        looksLikeProduct ? 'check' : 'na',
        looksLikeProduct
          ? 'This looks like a product page, but no Product in JSON-LD or microdata was found.'
          : 'No Product in JSON-LD or microdata was found, and this does not look like a product page. Open a product page to check this.',
        DOCS.listing));
      return res;
    }
    res.push(item(G, 'product-jsonld', 'Product structured data', 'ok',
      'Product found in ' + (pageHint && pageHint.formats && pageHint.formats.length ? fmt : 'structured data') + '.', DOCS.listing));

    res.push(item(G, 'name', 'name', hasValue(product.name) ? 'ok' : 'check',
      hasValue(product.name) ? 'name is present.' : 'name is missing or empty.', DOCS.listing));
    res.push(item(G, 'image', 'image', hasValue(product.image) ? 'ok' : 'check',
      hasValue(product.image) ? 'image is present.' : 'image is missing or empty.', DOCS.listing));

    var offers = flattenOffers(product);
    function offerField(id, label, getter) {
      if (!offers.length) {
        return item(G, id, label, 'check', 'No offers found, so ' + label + ' cannot be read.', DOCS.listing);
      }
      var missing = offers.filter(function (o) { return !hasValue(getter(o)); }).length;
      if (missing === 0) return item(G, id, label, 'ok', label + ' is present' + (offers.length > 1 ? ' in all ' + offers.length + ' offers.' : '.'), DOCS.listing);
      return item(G, id, label, 'check', label + ' is missing in ' + missing + ' of ' + offers.length + ' offer(s).', DOCS.listing);
    }
    res.push(offerField('price', 'offers.price', function (o) { return parsePrice(o.price) === null ? null : o.price; }));
    res.push(offerField('priceCurrency', 'offers.priceCurrency', function (o) { return o.priceCurrency; }));
    res.push(offerField('availability', 'offers.availability', function (o) { return o.availability; }));

    var bn = brandName(product.brand);
    res.push(item(G, 'brand', 'brand', bn ? 'ok' : 'check', bn ? 'brand is present.' : 'brand is missing or empty.', DOCS.listing));

    var foundIds = ID_KEYS.filter(function (k) { return hasValue(product[k]); });
    res.push(item(G, 'identifier', 'identifier (gtin / mpn / sku)', foundIds.length ? 'ok' : 'check',
      foundIds.length ? 'Found: ' + foundIds.join(', ') + '.' : 'None of gtin, gtin8/12/13/14, mpn, sku found.', DOCS.listing));

    var hasShip = offers.some(function (o) { return hasValue(o.shippingDetails); });
    res.push(item(G, 'shippingDetails', 'offers.shippingDetails', hasShip ? 'ok' : 'check',
      hasShip ? 'shippingDetails is present.' : 'Not in page markup. Shipping can also be set in Merchant Center; confirm it is set in at least one of the two places.', DOCS.listing));

    var hasRet = offers.some(function (o) { return hasValue(o.hasMerchantReturnPolicy); });
    res.push(item(G, 'returnPolicy', 'offers.hasMerchantReturnPolicy', hasRet ? 'ok' : 'check',
      hasRet ? 'hasMerchantReturnPolicy is present.' : 'Not in page markup. Return policy can also be set in Merchant Center; confirm it is set in at least one of the two places.', DOCS.listing));
    return res;
  }

  function collectPrices(product) {
    return flattenOffers(product).map(function (o) { return parsePrice(o.price); }).filter(function (n) { return n !== null; });
  }

  /* Compare JSON-LD price(s) with og:price:amount. */
  function comparePrices(ldPrices, ogPrice) {
    var G = 'Price match';
    var og = parsePrice(ogPrice);
    var lds = asArray(ldPrices).map(parsePrice).filter(function (n) { return n !== null; });
    if (og === null || !lds.length) {
      return item(G, 'price-match', 'Product data price vs og:price:amount', 'na',
        'Needs both a price in the product data (JSON-LD or microdata) and an og:price:amount meta tag; at least one was not found.', DOCS.misrep);
    }
    var match = lds.some(function (p) { return Math.abs(p - og) < 0.005; });
    return match
      ? item(G, 'price-match', 'Product data price vs og:price:amount', 'ok', 'Both show ' + og.toFixed(2) + '.', DOCS.misrep)
      : item(G, 'price-match', 'Product data price vs og:price:amount', 'check',
        'Product data price ' + lds.map(function (p) { return p.toFixed(2); }).join('/') + ' differs from og:price:amount ' + og.toFixed(2) + '.', DOCS.misrep);
  }

  /* Policy link matching. links: [{href, text}] */
  var POLICY_RULES = [
    { id: 'refund', label: 'Refund / return policy', ref: DOCS.editorial,
      path: /\/policies\/refund-policy|refund|return/i, text: /refund|\breturns?\b(?!\s+to\b)/i },
    { id: 'shipping', label: 'Shipping policy', ref: DOCS.misrep,
      path: /\/policies\/shipping-policy|shipping|delivery/i, text: /shipping|delivery/i },
    { id: 'privacy', label: 'Privacy policy', ref: DOCS.editorial,
      path: /\/policies\/privacy-policy|privacy/i, text: /privacy/i },
    { id: 'terms', label: 'Terms of service', ref: DOCS.editorial,
      path: /\/policies\/terms-of-service|terms/i, text: /\bterms\b/i },
    { id: 'contact', label: 'Contact page', ref: DOCS.editorial,
      path: /\/pages\/contact|contact/i, text: /contact/i }
  ];

  function pathOf(href) {
    var s = String(href || '');
    var m = s.match(/^(?:[a-z][a-z0-9+.\-]*:)?\/\/[^\/?#]*([^?#]*)/i);
    if (m) return m[1] || '/';
    return s.split(/[?#]/)[0];
  }

  function hostOf(href) {
    var m = String(href || '').match(/^(?:[a-z][a-z0-9+.\-]*:)?\/\/([^\/?#:]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
  function bareHost(h) { return String(h || '').toLowerCase().replace(/^www\./, ''); }
  /* A link is the store's own when it is relative, on the same site, or a Shopify-hosted policy page. Third-party links (for example a CAPTCHA provider's privacy page) do not count. */
  function isOwnLink(href, ownHost) {
    var h = bareHost(hostOf(href));
    var own = bareHost(ownHost);
    if (!h || !own) return true;
    if (h === own || h.slice(-(own.length + 1)) === '.' + own || own.slice(-(h.length + 1)) === '.' + h) return true;
    if (/\.myshopify\.com$/.test(h)) return true;
    if (/(^|\.)shopify\.com$/.test(h) && /\/policies\//i.test(pathOf(href))) return true;
    return false;
  }
  /* Catalog pages are not policy pages (e.g. a "FREE SHIPPING" banner that links to /collections/all). */
  var NON_POLICY_PATH = /^\/(collections|products|blogs|cart|search|account)(\/|$)/i;
  /* Promotional banner wording such as "FREE SHIPPING on orders over $50" or "20% off". */
  var PROMO_TEXT = /\bfree\b|\$|%|\d|\borders? over\b|\boff\b|\bsale\b/i;

  /* Returns { found: string|null, href: string } for one rule. href is '' for pop-up triggers. */
  function findPolicyLink(rule, list, ownHost) {
    for (var i = 0; i < list.length; i++) {
      var href = String(list[i].href || '');
      if (/^(mailto|tel|javascript):/i.test(href)) continue;
      if (href && !isOwnLink(href, ownHost)) continue;
      if (href && NON_POLICY_PATH.test(pathOf(href))) continue;
      var text = String(list[i].text || '').trim();
      if (PROMO_TEXT.test(text) && !(href && rule.path.test(pathOf(href)))) continue;
      var controls = String(list[i].controls || '');
      /* No href (pop-up trigger): count it only when it clearly names a policy, so a product "Shipping & Returns" accordion is not taken as a policy page. */
      if (!href && !/polic|terms|privacy/i.test(controls + ' ' + text)) continue;
      if ((href && rule.path.test(pathOf(href))) || (controls && rule.path.test(controls)) ||
          (text.length > 0 && text.length <= 60 && rule.text.test(text))) {
        return { found: href || ('"' + text + '" (opens on this page)'), href: href };
      }
    }
    return { found: null, href: '' };
  }

  function matchPolicyLinks(links, ownHost) {
    var list = asArray(links).filter(isObj);
    return POLICY_RULES.map(function (rule) {
      var found = findPolicyLink(rule, list, ownHost).found;
      return item('Policy links', 'policy-' + rule.id, rule.label,
        found ? 'ok' : 'check',
        found ? 'Link found: ' + found : 'No matching link found on this page. It may exist on other pages; add it to the footer or menu.',
        rule.ref);
    });
  }

  /* Policy pages whose contents are checked (same order as POLICY_RULES). hrefs: the store's own matched link, '' when none. */
  var CONTENT_IDS = ['refund', 'shipping', 'privacy', 'terms'];
  var STANDARD_POLICY_PATH = {
    refund: '/policies/refund-policy', shipping: '/policies/shipping-policy',
    privacy: '/policies/privacy-policy', terms: '/policies/terms-of-service'
  };
  function policyRuleById(id) {
    for (var i = 0; i < POLICY_RULES.length; i++) if (POLICY_RULES[i].id === id) return POLICY_RULES[i];
    return null;
  }
  /* Returns [{ rule, href }] for refund, shipping, privacy, terms. */
  function policyContentTargets(links, ownHost) {
    var list = asArray(links).filter(isObj);
    return CONTENT_IDS.map(function (id) {
      var rule = policyRuleById(id);
      return { rule: rule, href: findPolicyLink(rule, list, ownHost).href, standardPath: STANDARD_POLICY_PATH[id] };
    });
  }

  /* ---- policy page contents ---- */
  var PLACEHOLDER_RES = [
    /\[(?:LINK TO|INSERT|ENTER|YOUR|STORE|COMPANY|BUSINESS|EMAIL|PHONE|ADDRESS|NAME|DATE|NUMBER|URL)[A-Z0-9 _\-\/'&.,]*\]/g,
    /\[[A-Z][A-Z0-9 _\-\/'&.,]{3,60}\]/g
  ];
  var MIN_POLICY_CHARS = 40;

  function analyzePolicyText(text) {
    var clean = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
    var found = [];
    PLACEHOLDER_RES.forEach(function (re) {
      var m = clean.match(re) || [];
      m.forEach(function (p) { if (found.indexOf(p) === -1) found.push(p); });
    });
    return { length: clean.length, placeholders: found.slice(0, 5) };
  }

  var GP = 'Policy page contents';
  /* result: { status: HTTP status, finalSameOrigin: bool, text: string } or { skipped: 'reason' } or { failed: true }. */
  function evaluatePolicyPage(rule, result) {
    var label = rule.label;
    var id = 'content-' + rule.id;
    var r = isObj(result) ? result : {};
    if (r.skipped) return item(GP, id, label, 'na', String(r.skipped), rule.ref);
    if (r.failed || r.blocked || typeof r.status !== 'number' || r.status === 0) {
      return item(GP, id, label, 'na',
        'Could not load this page from the checker (it may be blocked by the store\'s security settings); open it yourself.', rule.ref);
    }
    if (r.finalSameOrigin === false) {
      return item(GP, id, label, 'na', 'The link leads to another site, so the checker did not read it; open it yourself.', rule.ref);
    }
    if (r.status !== 200) {
      return item(GP, id, label, 'check', 'The link goes to a page that returned HTTP ' + r.status + '.', rule.ref);
    }
    var a = analyzePolicyText(r.text);
    if (a.length < MIN_POLICY_CHARS) {
      return item(GP, id, label, 'check', 'The page loads but shows little or no policy text (' + a.length + ' characters).', rule.ref);
    }
    if (a.placeholders.length) {
      return item(GP, id, label, 'check', 'Template text still present, for example: ' + a.placeholders.slice(0, 3).join(', ') + '.', rule.ref);
    }
    return item(GP, id, label, 'ok', 'Policy text found (' + a.length + ' characters), no template placeholders spotted.', rule.ref);
  }

  var EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9\-]+(?:\.[A-Z0-9\-]+)*\.[A-Z]{2,}/gi;
  var PHONE_RES = [
    /(?:\+?1[\s.\-]?)?\(?\b\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/,
    /\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?(?:[\s.\-]?\d{2,4}){2,4}/
  ];
  var BAD_TLD = /\.(png|jpe?g|gif|webp|svg|avif|css|js)$/i;

  function findEmails(text, hrefs) {
    var found = [];
    asArray(hrefs).forEach(function (h) {
      var m = String(h || '').match(/^mailto:([^?]+)/i);
      if (m && /@/.test(m[1])) found.push(decodeURIComponent(m[1]));
    });
    var hits = String(text || '').match(EMAIL_RE) || [];
    hits.forEach(function (e) { if (!BAD_TLD.test(e)) found.push(e); });
    return found.filter(function (e, i) { return found.indexOf(e) === i; });
  }

  function findPhones(text, hrefs) {
    var found = [];
    asArray(hrefs).forEach(function (h) {
      var m = String(h || '').match(/^tel:(.+)$/i);
      if (m && /\d{6,}/.test(m[1].replace(/\D/g, ''))) found.push(decodeURIComponent(m[1]));
    });
    PHONE_RES.forEach(function (re) {
      var m = String(text || '').match(re);
      if (m) found.push(m[0].trim());
    });
    return found.filter(function (e, i) { return found.indexOf(e) === i; });
  }

  function evaluateContacts(text, hrefs) {
    var G = 'Contact details on this page';
    var emails = findEmails(text, hrefs);
    var phones = findPhones(text, hrefs);
    return [
      item(G, 'email', 'Email', emails.length ? 'ok' : 'check',
        emails.length ? 'Found: ' + emails[0] : 'No email found on this page. It may be on the contact page.', DOCS.editorial),
      item(G, 'phone', 'Phone', phones.length ? 'ok' : 'check',
        phones.length ? 'Found: ' + phones[0] : 'No phone number found on this page. It may be on the contact page.', DOCS.editorial),
      item(G, 'address', 'Business address', 'check',
        'Not judged by this tool. Please confirm yourself that your business address is shown where customers can find it.', DOCS.editorial)
    ];
  }

  /* imgs: [{alt: string|null, role, ariaHidden}] */
  function evaluateAlt(imgs) {
    var G = 'Images';
    var counted = asArray(imgs).filter(function (im) {
      if (!isObj(im)) return false;
      if (String(im.role || '').toLowerCase() === 'presentation') return false;
      if (String(im.ariaHidden || '').toLowerCase() === 'true') return false;
      return true;
    });
    var total = counted.length;
    var missing = counted.filter(function (im) { return im.alt === null || im.alt === undefined || String(im.alt).trim() === ''; }).length;
    if (total === 0) {
      return item(G, 'alt', 'Image alt text', 'na', 'No images counted on this page.', DOCS.images);
    }
    if (missing === 0) {
      return item(G, 'alt', 'Image alt text', 'ok', 'All ' + total + ' counted images have alt text.', DOCS.images);
    }
    return item(G, 'alt', 'Image alt text', 'check',
      missing + ' of ' + total + ' images have no alt text (purely decorative images can be fine). General accessibility check, not a Merchant Center rule by itself.', DOCS.images);
  }

  function summarize(items) {
    var s = { ok: 0, check: 0, na: 0 };
    items.forEach(function (i) { s[i.status] = (s[i.status] || 0) + 1; });
    return s;
  }

  /* One call that evaluates everything from plain data. */
  function runChecks(input) {
    var parsed = parseJsonLd(input.jsonLdTexts || []);
    var ldProduct = findProduct(parsed.nodes);
    var mdProduct = findProduct(microdataToNodes(input.microdata || []));
    var formats = [];
    if (ldProduct) formats.push('JSON-LD');
    if (mdProduct) formats.push('microdata');
    var product = mergeProducts(ldProduct, mdProduct);
    var path = String(input.path || '');
    var looksLikeProduct = /\/products\//i.test(path) || String(input.ogType || '').toLowerCase() === 'product';
    var items = [];
    items = items.concat(matchPolicyLinks(input.links || [], input.host || ''));
    items = items.concat(evaluateContacts(input.text || '', (input.links || []).map(function (l) { return l.href; })));
    items = items.concat(evaluateProduct(product, { looksLikeProduct: looksLikeProduct, formats: formats }));
    items.push(comparePrices(product ? collectPrices(product) : [], input.ogPrice));
    items.push(evaluateAlt(input.imgs || []));
    return { items: items, summary: summarize(items), jsonLdErrors: parsed.errors, formats: formats };
  }

  var core = {
    DOCS: DOCS, NOTICE: NOTICE, STATUS_LABEL: STATUS_LABEL,
    parseJsonLd: parseJsonLd, findProduct: findProduct, flattenOffers: flattenOffers,
    parsePrice: parsePrice, evaluateProduct: evaluateProduct, comparePrices: comparePrices,
    collectPrices: collectPrices, matchPolicyLinks: matchPolicyLinks, findEmails: findEmails,
    findPhones: findPhones, evaluateContacts: evaluateContacts, evaluateAlt: evaluateAlt,
    summarize: summarize, runChecks: runChecks,
    analyzePolicyText: analyzePolicyText, evaluatePolicyPage: evaluatePolicyPage, policyContentTargets: policyContentTargets,
    microdataToNodes: microdataToNodes, mergeProducts: mergeProducts, isProductItemtype: isProductItemtype
  };

  if (typeof module === 'object' && module && module.exports) {
    module.exports = core;
  }

  /* ---------------- DOM part (browser only) ---------------- */

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  var PANEL_ID = 'svl-store-check-panel';

  /* Read Product microdata into a plain tree. Value order: content attribute, then href/src for links and media, then text. */
  function microdataValue(e) {
    if (e.hasAttribute('content')) return e.getAttribute('content') || '';
    var tag = (e.tagName || '').toLowerCase();
    if (tag === 'a' || tag === 'link' || tag === 'area') return e.getAttribute('href') || '';
    if (tag === 'img' || tag === 'source' || tag === 'audio' || tag === 'video' || tag === 'iframe' || tag === 'embed' || tag === 'track') return e.getAttribute('src') || '';
    if (tag === 'object') return e.getAttribute('data') || '';
    if (tag === 'time' && e.hasAttribute('datetime')) return e.getAttribute('datetime') || '';
    if ((tag === 'data' || tag === 'meter') && e.hasAttribute('value')) return e.getAttribute('value') || '';
    return (e.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function readMicrodataItem(el, depth) {
    var props = [];
    function walk(node) {
      Array.prototype.forEach.call(node.children || [], function (ch) {
        var names = (ch.getAttribute('itemprop') || '').split(/\s+/).filter(Boolean);
        var isScope = ch.hasAttribute('itemscope');
        if (names.length) {
          names.forEach(function (n) {
            if (isScope) { if (depth < 5) props.push({ name: n, item: readMicrodataItem(ch, depth + 1) }); }
            else props.push({ name: n, value: microdataValue(ch) });
          });
        }
        if (!isScope) walk(ch);
      });
    }
    walk(el);
    return { type: el.getAttribute('itemtype') || '', props: props };
  }

  function readMicrodata() {
    var all = Array.prototype.filter.call(document.querySelectorAll('[itemscope][itemtype]'),
      function (e) { return isProductItemtype(e.getAttribute('itemtype')); });
    var tops = all.filter(function (e) { return !e.hasAttribute('itemprop'); });
    if (!tops.length) tops = all.slice(0, 1);
    return tops.map(function (e) { return readMicrodataItem(e, 0); });
  }

  function readPage() {
    var jsonLdTexts = Array.prototype.map.call(
      document.querySelectorAll('script[type="application/ld+json"]'),
      function (s) { return s.textContent || ''; });
    /* Some themes open policies in a pop-up: <a role="button" aria-controls="modal-privacy-policy"> with no href. */
    var links = Array.prototype.map.call(
      document.querySelectorAll('a[href], a[aria-controls], a[role="button"], button[aria-controls]'), function (a) {
        return {
          href: a.getAttribute('href') || '',
          text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
          controls: a.getAttribute('aria-controls') || ''
        };
      });
    var og = document.querySelector('meta[property="og:price:amount"]');
    var ogType = document.querySelector('meta[property="og:type"]');
    var imgs = Array.prototype.map.call(document.querySelectorAll('img'), function (im) {
      var hiddenAncestor = im.closest ? im.closest('[aria-hidden="true"]') : null;
      return {
        alt: im.hasAttribute('alt') ? im.getAttribute('alt') : null,
        role: im.getAttribute('role') || '',
        ariaHidden: hiddenAncestor ? 'true' : (im.getAttribute('aria-hidden') || '')
      };
    });
    var text = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    return {
      jsonLdTexts: jsonLdTexts, microdata: readMicrodata(), links: links, text: text, imgs: imgs,
      ogPrice: og ? og.getAttribute('content') : null,
      ogType: ogType ? ogType.getAttribute('content') : null,
      path: location.pathname,
      host: location.hostname
    };
  }

  function el(tag, props, children) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'text') e.textContent = props[k];
      else if (k === 'style') e.setAttribute('style', props[k]);
      else e.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  /* ---- policy page contents (DOM part): GET only, same origin, 6 s timeout ---- */
  var FETCH_TIMEOUT_MS = 6000;

  function policyPageText(doc) {
    var root = doc.querySelector('.shopify-policy__body') || doc.querySelector('main') || doc.body;
    if (!root) return '';
    var copy = root.cloneNode(true);
    Array.prototype.forEach.call(copy.querySelectorAll('script, style, noscript, nav, header, footer'), function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    return copy.textContent || '';
  }

  /* Resolves to a result for evaluatePolicyPage. Never rejects. */
  function loadPolicyPage(url) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      try {
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctrl) ctrl.abort(); finish({ failed: true }); }, FETCH_TIMEOUT_MS);
        var opts = { method: 'GET', credentials: 'same-origin', redirect: 'follow' };
        if (ctrl) opts.signal = ctrl.signal;
        fetch(url, opts).then(function (resp) {
          var sameOrigin = false;
          try { sameOrigin = new URL(resp.url || url, location.href).origin === location.origin; } catch (e) { sameOrigin = false; }
          if (!sameOrigin) { clearTimeout(timer); finish({ status: resp.status, finalSameOrigin: false, text: '' }); return null; }
          if (resp.status !== 200) { clearTimeout(timer); finish({ status: resp.status, finalSameOrigin: true, text: '' }); return null; }
          return resp.text().then(function (html) {
            clearTimeout(timer);
            var text = policyPageText(new DOMParser().parseFromString(html, 'text/html'));
            finish({ status: resp.status, finalSameOrigin: true, text: text });
          });
        }).catch(function () { clearTimeout(timer); finish({ failed: true }); });
      } catch (e) {
        finish({ failed: true });
      }
    });
  }

  /* Pick the URL to open for one policy: the store's own matched link (same origin only), else the standard Shopify path when window.Shopify exists. */
  function policyUrlFor(target) {
    if (target.href) {
      try {
        var u = new URL(target.href, location.href);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === location.origin) return { url: u.href };
        return { skip: 'The link on this page leads to another site, so the checker did not open it; open it yourself.' };
      } catch (e) {
        return { skip: 'The link on this page could not be read, so the checker did not open it.' };
      }
    }
    if (window.Shopify) return { url: location.origin + target.standardPath };
    return { skip: 'No link to this policy was found on this page, so there was nothing to open.' };
  }

  function loadPolicyResults(targets) {
    return Promise.all(targets.map(function (t) {
      var pick;
      try { pick = policyUrlFor(t); } catch (e) { pick = { skip: 'Could not prepare this page for checking.' }; }
      if (!pick.url) return Promise.resolve(evaluatePolicyPage(t.rule, { skipped: pick.skip }));
      return loadPolicyPage(pick.url).then(function (r) {
        try { return evaluatePolicyPage(t.rule, r); } catch (e) { return evaluatePolicyPage(t.rule, { failed: true }); }
      }, function () { return evaluatePolicyPage(t.rule, { failed: true }); });
    }));
  }

  var COLORS = { ok: '#0a6b2d', check: '#8a4b00', na: '#555555' };
  var BG = { ok: '#e6f4ea', check: '#fff3e0', na: '#eeeeee' };

  function render() {
    var old = document.getElementById(PANEL_ID);
    if (old) { old.parentNode.removeChild(old); return; }

    var pageData = readPage();
    var result = runChecks(pageData);
    var host = el('div', { id: PANEL_ID, style: 'all:initial;position:fixed;right:8px;bottom:8px;z-index:2147483647;' });
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var css = el('style', { text:
      '.p{box-sizing:border-box;width:min(360px,calc(100vw - 16px));max-height:75vh;display:flex;flex-direction:column;' +
      'background:#fff;color:#111;border:1px solid #888;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);' +
      'font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:left}' +
      '.h{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #ddd;background:#f6f6f6;border-radius:8px 8px 0 0}' +
      '.h b{font-size:14px}.x{font:inherit;font-size:18px;line-height:1;min-width:36px;min-height:36px;border:1px solid #888;border-radius:6px;background:#fff;color:#111;cursor:pointer}' +
      '.s{padding:6px 10px;border-bottom:1px solid #eee;font-weight:600}' +
      '.b{overflow:auto;padding:4px 10px;flex:1 1 auto;-webkit-overflow-scrolling:touch}' +
      '.g{margin:8px 0 2px;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#333}' +
      '.r{padding:5px 0;border-bottom:1px solid #f0f0f0}.r .t{display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}' +
      '.k{display:inline-block;padding:1px 6px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap}' +
      '.n{font-weight:600;word-break:break-word}.m{margin:2px 0 0;color:#333;word-break:break-word;overflow-wrap:anywhere}' +
      '.m a{color:#0b57d0}.f{padding:8px 10px;border-top:1px solid #ddd;background:#f6f6f6;font-size:11px;color:#333;border-radius:0 0 8px 8px}' });

    var closeBtn = el('button', { class: 'x', type: 'button', 'aria-label': 'Close results panel', text: '\u00D7' });
    function close() { if (host.parentNode) host.parentNode.removeChild(host); document.removeEventListener('keydown', onKey, true); }
    function onKey(ev) { if (ev.key === 'Escape') close(); }
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);

    var s = result.summary;
    var head = el('div', { class: 'h' }, [el('b', { text: 'Store Page Check' }), closeBtn]);
    var sum = el('div', { class: 's', text: 'OK ' + s.ok + '  |  Check ' + s.check + '  |  N/A ' + s.na });
    var body = el('div', { class: 'b', role: 'region', 'aria-label': 'Check results' });

    function makeRow(it) {
      var badge = el('span', { class: 'k', style: 'background:' + BG[it.status] + ';color:' + COLORS[it.status], text: STATUS_LABEL[it.status] });
      var docs = el('a', { href: it.ref, target: '_blank', rel: 'noopener noreferrer', text: 'Google docs' });
      return el('div', { class: 'r' }, [
        el('div', { class: 't' }, [badge, el('span', { class: 'n', text: it.label })]),
        el('p', { class: 'm', style: 'margin:2px 0 0' }, [document.createTextNode(it.reason + ' '), docs])
      ]);
    }
    var lastGroup = null;
    result.items.forEach(function (it) {
      if (it.group !== lastGroup) { body.appendChild(el('div', { class: 'g', text: it.group })); lastGroup = it.group; }
      body.appendChild(makeRow(it));
    });
    var policyHeader = el('div', { class: 'g', text: 'Policy page contents' });
    var policyWait = el('p', { class: 'm', text: 'Checking policy pages...' });
    body.appendChild(policyHeader);
    body.appendChild(policyWait);
    body.appendChild(el('p', { class: 'm', text: 'Product structured data found: ' + formatsText(result.formats) + '. (These are notes to look at, not verdicts.)' }));
    if (result.jsonLdErrors) {
      body.appendChild(el('p', { class: 'm', text: result.jsonLdErrors + ' JSON-LD block(s) could not be parsed and were skipped.' }));
    }
    var foot = el('div', { class: 'f', text: NOTICE });

    root.appendChild(css);
    root.appendChild(el('div', { class: 'p', role: 'dialog', 'aria-label': 'Store Page Check results' }, [head, sum, body, foot]));
    document.body.appendChild(host);

    /* Second step: open the store's own policy pages (GET, same site) and add their results. Any problem shows as N/A; the panel keeps working. */
    var panelOpen = true;
    closeBtn.addEventListener('click', function () { panelOpen = false; });
    document.addEventListener('keydown', function esc(ev) {
      if (ev.key === 'Escape') { panelOpen = false; document.removeEventListener('keydown', esc, true); }
    }, true);
    var targets = [];
    try { targets = policyContentTargets(pageData.links, pageData.host); } catch (e) { targets = []; }
    loadPolicyResults(targets).then(function (items) {
      if (!panelOpen || !host.parentNode) return;
      try {
        var frag = document.createDocumentFragment();
        items.forEach(function (it) { frag.appendChild(makeRow(it)); });
        body.insertBefore(frag, policyWait);
        body.removeChild(policyWait);
        var s2 = summarize(result.items.concat(items));
        sum.textContent = 'OK ' + s2.ok + '  |  Check ' + s2.check + '  |  N/A ' + s2.na;
      } catch (e) {
        policyWait.textContent = 'Policy pages could not be checked (N/A).';
      }
    }, function () {
      if (policyWait.parentNode) policyWait.textContent = 'Policy pages could not be checked (N/A).';
    });
  }

  render();
})();
