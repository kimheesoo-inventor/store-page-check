// Unit tests for the pure judgement functions in checker.js. Node built-ins only.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const c = require('./checker.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); }
}
const st = (items, id) => items.find((i) => i.id === id).status;

const goodProduct = {
  '@context': 'https://schema.org', '@type': 'Product', name: 'Mug', image: ['https://x/y.jpg'],
  brand: { '@type': 'Brand', name: 'Acme' }, sku: 'MUG-1',
  offers: { '@type': 'Offer', price: '19.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock',
    shippingDetails: { '@type': 'OfferShippingDetails' }, hasMerchantReturnPolicy: { '@type': 'MerchantReturnPolicy' } }
};

/* ---- JSON-LD parsing ---- */
t('parseJsonLd: single object', () => {
  const r = c.parseJsonLd([JSON.stringify(goodProduct)]);
  assert.equal(r.nodes.length, 1); assert.equal(r.errors, 0);
});
t('parseJsonLd: @graph is flattened', () => {
  const r = c.parseJsonLd([JSON.stringify({ '@graph': [{ '@type': 'Organization' }, goodProduct] })]);
  assert.ok(c.findProduct(r.nodes));
});
t('parseJsonLd: top-level array', () => {
  const r = c.parseJsonLd([JSON.stringify([{ '@type': 'WebSite' }, goodProduct])]);
  assert.equal(c.findProduct(r.nodes).name, 'Mug');
});
t('parseJsonLd: broken JSON counted as error, others still read', () => {
  const r = c.parseJsonLd(['{not json', JSON.stringify(goodProduct)]);
  assert.equal(r.errors, 1); assert.ok(c.findProduct(r.nodes));
});
t('findProduct: @type array containing Product', () => {
  const p = c.findProduct([{ '@type': ['Product', 'Thing'], name: 'A' }]);
  assert.equal(p.name, 'A');
});
t('findProduct: none -> null', () => {
  assert.equal(c.findProduct([{ '@type': 'Organization' }]), null);
});
t('findProduct: ProductGroup merges variant offers', () => {
  const g = { '@type': 'ProductGroup', name: 'Shirt', brand: 'B', hasVariant: [
    { '@type': 'Product', sku: 'S1', offers: { price: '10', priceCurrency: 'USD', availability: 'x' } },
    { '@type': 'Product', sku: 'S2', offers: { price: '12', priceCurrency: 'USD', availability: 'x' } }] };
  const p = c.findProduct([g]);
  assert.equal(c.flattenOffers(p).length, 2); assert.equal(p.sku, 'S1');
});

/* ---- product field judgement ---- */
t('evaluateProduct: complete product -> all ok', () => {
  const items = c.evaluateProduct(goodProduct, {});
  const bad = items.filter((i) => i.status !== 'ok');
  assert.equal(bad.length, 0, JSON.stringify(bad.map((b) => b.id)));
});
t('evaluateProduct: missing fields -> check', () => {
  const items = c.evaluateProduct({ '@type': 'Product', offers: { price: '5' } }, {});
  for (const id of ['name', 'image', 'priceCurrency', 'availability', 'brand', 'identifier', 'shippingDetails', 'returnPolicy'])
    assert.equal(st(items, id), 'check', id);
  assert.equal(st(items, 'price'), 'ok');
});
t('evaluateProduct: offers array, one offer lacks currency -> check', () => {
  const p = { ...goodProduct, offers: [goodProduct.offers, { price: '3', availability: 'x' }] };
  assert.equal(st(c.evaluateProduct(p, {}), 'priceCurrency'), 'check');
  assert.equal(st(c.evaluateProduct(p, {}), 'price'), 'ok');
});
t('evaluateProduct: AggregateOffer lowPrice is read', () => {
  const p = { ...goodProduct, offers: { '@type': 'AggregateOffer', lowPrice: '8.00', highPrice: '9.00', priceCurrency: 'USD', availability: 'x' } };
  const items = c.evaluateProduct(p, {});
  assert.equal(st(items, 'price'), 'ok'); assert.equal(st(items, 'priceCurrency'), 'ok');
});
t('evaluateProduct: AggregateOffer with nested offers', () => {
  const p = { ...goodProduct, offers: { '@type': 'AggregateOffer', offers: [{ price: '1', priceCurrency: 'USD', availability: 'x' }, { price: '2', priceCurrency: 'USD', availability: 'x' }] } };
  assert.equal(c.flattenOffers(p).length, 2);
});
t('evaluateProduct: offers missing entirely -> check', () => {
  const items = c.evaluateProduct({ '@type': 'Product', name: 'x' }, {});
  assert.equal(st(items, 'price'), 'check');
});
t('evaluateProduct: empty-string values are treated as missing', () => {
  const items = c.evaluateProduct({ '@type': 'Product', name: '  ', image: '', brand: { name: '' }, sku: '', offers: { price: '', priceCurrency: '', availability: '' } }, {});
  for (const id of ['name', 'image', 'brand', 'identifier', 'price', 'priceCurrency', 'availability']) assert.equal(st(items, id), 'check', id);
});
t('evaluateProduct: brand as plain string and gtin13 identifier', () => {
  const items = c.evaluateProduct({ ...goodProduct, brand: 'Acme', sku: undefined, gtin13: '4006381333931' }, {});
  assert.equal(st(items, 'brand'), 'ok'); assert.equal(st(items, 'identifier'), 'ok');
});
t('evaluateProduct: no product on non-product page -> na', () => {
  assert.equal(c.evaluateProduct(null, { looksLikeProduct: false })[0].status, 'na');
});
t('evaluateProduct: no product on product-looking page -> check', () => {
  assert.equal(c.evaluateProduct(null, { looksLikeProduct: true })[0].status, 'check');
});

/* ---- microdata (L019) ---- */
const mdOffer = (extra = []) => ({ type: 'http://schema.org/Offer', props: [
  { name: 'price', value: '24.00' }, { name: 'priceCurrency', value: 'USD' },
  { name: 'availability', value: 'http://schema.org/InStock' }, ...extra] });
const mdGood = { type: 'http://schema.org/Product', props: [
  { name: 'name', value: 'Candle' }, { name: 'image', value: '//cdn.example/c.jpg' },
  { name: 'brand', value: 'Glow Co' }, { name: 'sku', value: 'C-1' },
  { name: 'offers', item: mdOffer() }] };
const mdNoIds = { type: 'https://schema.org/Product', props: [
  { name: 'name', value: 'Candle' }, { name: 'offers', item: { type: 'https://schema.org/Offer', props: [{ name: 'price', value: '24.00' }] } }] };
const base = { links: [], text: '', ogPrice: null, ogType: 'product', path: '/products/candle', imgs: [] };

t('isProductItemtype: http, https and case are accepted; other types are not', () => {
  assert.ok(c.isProductItemtype('http://schema.org/Product'));
  assert.ok(c.isProductItemtype('https://schema.org/product'));
  assert.ok(c.isProductItemtype('HTTP://SCHEMA.ORG/PRODUCT'));
  assert.ok(!c.isProductItemtype('http://schema.org/ProductModel'));
  assert.ok(!c.isProductItemtype('http://schema.org/Offer'));
  assert.ok(!c.isProductItemtype(''));
});
t('microdataToNodes: nested offers and repeated props become JSON-LD-like nodes', () => {
  const nodes = c.microdataToNodes([{ type: 'http://schema.org/Product', props: [
    { name: 'sku', value: 'A' }, { name: 'sku', value: 'B' }, { name: 'offers', item: mdOffer() }] }]);
  const p = c.findProduct(nodes);
  assert.deepEqual(p.sku, ['A', 'B']);
  assert.equal(c.flattenOffers(p)[0].priceCurrency, 'USD');
});
t('runChecks: microdata-only product page is NOT reported as missing structured data', () => {
  const r = c.runChecks({ ...base, jsonLdTexts: [], microdata: [mdGood] });
  assert.equal(st(r.items, 'product-jsonld'), 'ok');
  assert.ok(/Product found in microdata\./.test(r.items.find((i) => i.id === 'product-jsonld').reason));
  assert.deepEqual(r.formats, ['microdata']);
  for (const id of ['name', 'image', 'price', 'priceCurrency', 'availability', 'brand', 'identifier']) assert.equal(st(r.items, id), 'ok', id);
  assert.ok(!r.items.some((i) => /no Product/i.test(i.reason)));
});
t('runChecks: microdata price is compared with og:price:amount', () => {
  assert.equal(st(c.runChecks({ ...base, jsonLdTexts: [], microdata: [mdGood], ogPrice: '24.00' }).items, 'price-match'), 'ok');
  assert.equal(st(c.runChecks({ ...base, jsonLdTexts: [], microdata: [mdGood], ogPrice: '30.00' }).items, 'price-match'), 'check');
});
t('runChecks: microdata with missing identifiers/brand/currency is reported as worth a look', () => {
  const r = c.runChecks({ ...base, jsonLdTexts: [], microdata: [mdNoIds] });
  assert.equal(st(r.items, 'product-jsonld'), 'ok');
  for (const id of ['identifier', 'brand', 'image', 'priceCurrency', 'availability']) assert.equal(st(r.items, id), 'check', id);
  assert.equal(st(r.items, 'name'), 'ok'); assert.equal(st(r.items, 'price'), 'ok');
});
t('runChecks: microdata gtin13 / mpn and shippingDetails / return policy are read', () => {
  const md = { type: 'http://schema.org/Product', props: [{ name: 'gtin13', value: '4006381333931' },
    { name: 'offers', item: mdOffer([{ name: 'shippingDetails', item: { type: 'http://schema.org/OfferShippingDetails', props: [{ name: 'shippingRate', value: 'x' }] } },
      { name: 'hasMerchantReturnPolicy', item: { type: 'http://schema.org/MerchantReturnPolicy', props: [{ name: 'returnPolicyCategory', value: 'x' }] } }]) }] };
  const r = c.runChecks({ ...base, jsonLdTexts: [], microdata: [md] });
  assert.equal(st(r.items, 'identifier'), 'ok'); assert.equal(st(r.items, 'shippingDetails'), 'ok'); assert.equal(st(r.items, 'returnPolicy'), 'ok');
  assert.equal(st(c.runChecks({ ...base, jsonLdTexts: [], microdata: [{ type: 'http://schema.org/Product', props: [{ name: 'mpn', value: 'M1' }] }] }).items, 'identifier'), 'ok');
});
t('runChecks: both JSON-LD and microdata are merged and both formats are named', () => {
  const ld = { '@type': 'Product', name: 'Candle', offers: { price: '24.00' } };
  const r = c.runChecks({ ...base, jsonLdTexts: [JSON.stringify(ld)], microdata: [mdGood] });
  const reason = r.items.find((i) => i.id === 'product-jsonld').reason;
  assert.ok(/Product found in JSON-LD \+ microdata\./.test(reason), reason);
  assert.deepEqual(r.formats, ['JSON-LD', 'microdata']);
  for (const id of ['brand', 'identifier', 'image', 'priceCurrency', 'availability']) assert.equal(st(r.items, id), 'ok', id);
});
t('runChecks: when both formats exist, JSON-LD values win over microdata', () => {
  const ld = { '@type': 'Product', name: 'From LD', offers: { price: '10.00', priceCurrency: 'USD', availability: 'x' } };
  const merged = c.mergeProducts(c.findProduct([ld]), c.findProduct(c.microdataToNodes([mdGood])));
  assert.equal(merged.name, 'From LD'); assert.equal(merged.brand, 'Glow Co');
  assert.equal(c.flattenOffers(merged)[0].price, '10.00');
});
t('runChecks: JSON-LD only says Product found in JSON-LD', () => {
  const r = c.runChecks({ ...base, jsonLdTexts: [JSON.stringify(goodProduct)] });
  assert.ok(/Product found in JSON-LD\./.test(r.items.find((i) => i.id === 'product-jsonld').reason));
  assert.deepEqual(r.formats, ['JSON-LD']);
});
t('runChecks: neither JSON-LD nor microdata on a product page is still reported as missing', () => {
  const r = c.runChecks({ ...base, jsonLdTexts: [], microdata: [] });
  assert.equal(st(r.items, 'product-jsonld'), 'check');
  assert.ok(/no Product in JSON-LD or microdata was found\./.test(r.items.find((i) => i.id === 'product-jsonld').reason));
  assert.deepEqual(r.formats, []);
});
t('runChecks: microdata of a non-Product type does not count as a product', () => {
  const r = c.runChecks({ ...base, jsonLdTexts: [], microdata: [{ type: 'http://schema.org/Organization', props: [{ name: 'name', value: 'X' }] }] });
  assert.equal(st(r.items, 'product-jsonld'), 'check');
});

/* ---- price comparison ---- */
t('comparePrices: same price -> ok', () => assert.equal(c.comparePrices(['19.99'], '19.99').status, 'ok'));
t('comparePrices: formatting differences ($, comma) still ok', () => assert.equal(c.comparePrices([1299], '$1,299.00').status, 'ok'));
t('comparePrices: different price -> check', () => assert.equal(c.comparePrices(['19.99'], '24.99').status, 'check'));
t('comparePrices: og missing -> na', () => assert.equal(c.comparePrices(['19.99'], null).status, 'na'));
t('comparePrices: JSON-LD missing -> na', () => assert.equal(c.comparePrices([], '19.99').status, 'na'));
t('comparePrices: any variant price matching is ok', () => assert.equal(c.comparePrices(['10', '12'], '12.00').status, 'ok'));
t('parsePrice: garbage -> null', () => assert.equal(c.parsePrice('free'), null));
t('parsePrice: decimal comma', () => assert.equal(c.parsePrice('12,50'), 12.5));

/* ---- policy links ---- */
const fullLinks = [
  { href: '/policies/refund-policy', text: 'Refund policy' },
  { href: '/policies/shipping-policy', text: 'Shipping' },
  { href: 'https://shop.example/policies/privacy-policy', text: 'Privacy' },
  { href: '/policies/terms-of-service', text: 'Terms' },
  { href: '/pages/contact', text: 'Contact us' }
];
t('matchPolicyLinks: Shopify default paths -> all ok', () => {
  const r = c.matchPolicyLinks(fullLinks);
  assert.equal(r.length, 5); assert.ok(r.every((x) => x.status === 'ok'));
});
t('matchPolicyLinks: path only (empty link text) is recognized', () => {
  const r = c.matchPolicyLinks([{ href: '/policies/refund-policy', text: '' }, { href: '/pages/contact', text: '' }]);
  assert.equal(st(r, 'policy-refund'), 'ok'); assert.equal(st(r, 'policy-contact'), 'ok');
});
t('matchPolicyLinks: text only (custom URL) is recognized', () => {
  const r = c.matchPolicyLinks([{ href: '/pages/our-info', text: 'Returns' }, { href: '/p/info2', text: 'Shipping info' }]);
  assert.equal(st(r, 'policy-refund'), 'ok'); assert.equal(st(r, 'policy-shipping'), 'ok');
});
t('matchPolicyLinks: no links -> all check', () => {
  assert.ok(c.matchPolicyLinks([]).every((x) => x.status === 'check'));
});
t('matchPolicyLinks: missing privacy and terms only -> those two check', () => {
  const r = c.matchPolicyLinks(fullLinks.filter((l) => !/privacy|terms/.test(l.href)));
  assert.equal(st(r, 'policy-privacy'), 'check'); assert.equal(st(r, 'policy-terms'), 'check');
  assert.equal(st(r, 'policy-refund'), 'ok');
});
t('matchPolicyLinks: "Return to shop" and mailto links are not refund links', () => {
  const r = c.matchPolicyLinks([{ href: '/collections/all', text: 'Return to shop' }, { href: 'mailto:returns@shop.example', text: 'returns@shop.example' }]);
  assert.equal(st(r, 'policy-refund'), 'check');
});
t('matchPolicyLinks: pop-up policy triggers without href (pop-up trigger style) are recognized', () => {
  const r = c.matchPolicyLinks([
    { href: '', text: 'Privacy policy', controls: 'modal-privacy-policy' },
    { href: '', text: 'Terms of service', controls: 'modal-terms-of-service' },
    { href: '', text: 'Shipping policy', controls: 'modal-shipping-policy' }]);
  assert.equal(st(r, 'policy-privacy'), 'ok'); assert.equal(st(r, 'policy-terms'), 'ok'); assert.equal(st(r, 'policy-shipping'), 'ok');
  assert.ok(/opens on this page/.test(r.find((x) => x.id === 'policy-privacy').reason));
});
t('matchPolicyLinks: product accordion "Shipping & Returns" without href is not a policy link', () => {
  const r = c.matchPolicyLinks([{ href: '', text: 'Shipping & Returns', controls: 'accordion-3' }]);
  assert.equal(st(r, 'policy-shipping'), 'check'); assert.equal(st(r, 'policy-refund'), 'check');
});
t('matchPolicyLinks: third-party privacy/terms links (CAPTCHA provider) are not store policies (L015)', () => {
  const r = c.matchPolicyLinks([
    { href: 'https://www.hcaptcha.com/privacy', text: 'Privacy Policy' },
    { href: 'https://www.hcaptcha.com/terms', text: 'Terms' }], 'candle-shop.example');
  assert.equal(st(r, 'policy-privacy'), 'check'); assert.equal(st(r, 'policy-terms'), 'check');
});
t('matchPolicyLinks: same-site absolute, www and Shopify-hosted policy links still count', () => {
  const r = c.matchPolicyLinks([
    { href: 'https://www.shop.example/policies/privacy-policy', text: 'Privacy' },
    { href: 'https://shop-x.myshopify.com/policies/terms-of-service', text: 'Terms' },
    { href: 'https://checkout.shopify.com/123/policies/456.html', text: 'Refund policy' }], 'shop.example');
  assert.equal(st(r, 'policy-privacy'), 'ok'); assert.equal(st(r, 'policy-terms'), 'ok'); assert.equal(st(r, 'policy-refund'), 'ok');
});
t('matchPolicyLinks: "FREE SHIPPING" banner links are not a shipping policy (L015)', () => {
  const r = c.matchPolicyLinks([
    { href: '/collections/all', text: 'FREE SHIPPING' },
    { href: '/pages/sale', text: 'Free shipping on orders over $50' }], 'shop.example');
  assert.equal(st(r, 'policy-shipping'), 'check');
});
t('matchPolicyLinks: real shipping policy path counts even with promo-like text', () => {
  const r = c.matchPolicyLinks([{ href: '/policies/shipping-policy', text: 'Free shipping details' }], 'shop.example');
  assert.equal(st(r, 'policy-shipping'), 'ok');
});
t('matchPolicyLinks: unrelated links -> check', () => {
  const r = c.matchPolicyLinks([{ href: '/collections/all', text: 'Shop all' }, { href: '/blogs/news', text: 'News' }]);
  assert.ok(r.every((x) => x.status === 'check'));
});

/* ---- contacts ---- */
t('contacts: mailto + tel links -> ok/ok, address always check', () => {
  const r = c.evaluateContacts('', ['mailto:help@shop.example?subject=Hi', 'tel:+15551234567']);
  assert.equal(st(r, 'email'), 'ok'); assert.equal(st(r, 'phone'), 'ok'); assert.equal(st(r, 'address'), 'check');
});
t('contacts: patterns in visible text', () => {
  const r = c.evaluateContacts('Write to support@shop.example or call (555) 123-4567.', []);
  assert.equal(st(r, 'email'), 'ok'); assert.equal(st(r, 'phone'), 'ok');
});
t('contacts: neither present -> check/check', () => {
  const r = c.evaluateContacts('Welcome to our store. Price $19.99 SKU 12345', []);
  assert.equal(st(r, 'email'), 'check'); assert.equal(st(r, 'phone'), 'check');
});
t('contacts: image file name with @2x is not an email', () => {
  assert.equal(c.findEmails('logo@2x.png', []).length, 0);
});
t('contacts: mailto with two @ signs -> email check, address named, not counted as found', () => {
  const r = c.evaluateContacts('', ['mailto:hello@sharonmoskal@gmail.com']);
  assert.equal(st(r, 'email'), 'check');
  const msg = r.find((x) => x.id === 'email' || /email/i.test(x.label)).message || JSON.stringify(r);
  assert.ok(/hello@sharonmoskal@gmail\.com/.test(JSON.stringify(r)) && /more than one @/.test(JSON.stringify(r)), msg);
  assert.equal(c.findEmails('', ['mailto:hello@sharonmoskal@gmail.com']).length, 0);
});
t('contacts: valid email plus one broken mailto -> still check', () => {
  const r = c.evaluateContacts('Write to help@shop.example', ['mailto:help@shopexample']);
  assert.equal(st(r, 'email'), 'check');
  assert.ok(/not a complete domain/.test(JSON.stringify(r)));
});
t('contacts: share-by-email mailto with no address is not flagged', () => {
  assert.equal(c.findBrokenMailto(['mailto:?subject=Look&body=https%3A%2F%2Fshop.example']).length, 0);
  assert.equal(c.findBrokenMailto(['mailto:']).length, 0);
});
t('contacts: two addresses in one mailto and encoded @ are fine', () => {
  const r = c.evaluateContacts('', ['mailto:a@shop.example,b@shop.example', 'mailto:hello%40shop.example']);
  assert.equal(st(r, 'email'), 'ok');
  assert.equal(c.findBrokenMailto(['mailto:a@shop.example, b@shop.example', 'mailto:hello%40shop.example']).length, 0);
});
t('contacts: mailto with a space or double dot is flagged', () => {
  assert.equal(c.findBrokenMailto(['mailto:info@shop .com']).length, 1);
  assert.equal(c.findBrokenMailto(['mailto:info@shop..com']).length, 1);
  assert.equal(c.findBrokenMailto(['tel:+15551234567', '/pages/contact']).length, 0);
});
t('contacts: international phone pattern', () => {
  assert.equal(c.findPhones('Call +44 20 7946 0958', []).length, 1);
});

/* ---- images ---- */
t('alt: all have alt -> ok', () => assert.equal(c.evaluateAlt([{ alt: 'a' }, { alt: 'b' }]).status, 'ok'));
t('alt: missing and empty alt -> check', () => {
  const r = c.evaluateAlt([{ alt: 'a' }, { alt: null }, { alt: '' }]);
  assert.equal(r.status, 'check'); assert.ok(/2 of 3/.test(r.reason));
});
t('alt: presentation / aria-hidden images excluded', () => {
  const r = c.evaluateAlt([{ alt: '', role: 'presentation' }, { alt: null, ariaHidden: 'true' }, { alt: 'ok' }]);
  assert.equal(r.status, 'ok'); assert.ok(/All 1/.test(r.reason));
});
t('alt: no images -> na', () => assert.equal(c.evaluateAlt([]).status, 'na'));

/* ---- end to end on plain data ---- */
t('runChecks: healthy product page has no check items except address', () => {
  const r = c.runChecks({ jsonLdTexts: [JSON.stringify(goodProduct)], links: fullLinks.concat([{ href: 'mailto:a@shop.example', text: 'a@shop.example' }]),
    text: 'Call 555-123-4567', ogPrice: '19.99', ogType: 'product', path: '/products/mug', imgs: [{ alt: 'mug' }] });
  const checks = r.items.filter((i) => i.status === 'check').map((i) => i.id);
  assert.deepEqual(checks, ['address']);
});
t('runChecks: deliberately wrong input is flagged "check"', () => {
  const bad = { '@type': 'Product', name: '', offers: { price: 'abc' } };
  const r = c.runChecks({ jsonLdTexts: [JSON.stringify(bad), '{broken'], links: [], text: '', ogPrice: '9.99', ogType: 'product', path: '/products/x', imgs: [{ alt: '' }] });
  assert.ok(r.summary.check >= 12, 'check count ' + r.summary.check);
  assert.equal(r.jsonLdErrors, 1);
  assert.equal(st(r.items, 'name'), 'check'); assert.equal(st(r.items, 'price'), 'check');
  assert.equal(st(r.items, 'price-match'), 'na'); assert.equal(st(r.items, 'alt'), 'check');
});
t('runChecks: non-product page -> product items na', () => {
  const r = c.runChecks({ jsonLdTexts: [], links: [], text: '', ogPrice: null, ogType: 'website', path: '/', imgs: [] });
  assert.equal(st(r.items, 'product-jsonld'), 'na'); assert.equal(st(r.items, 'price-match'), 'na');
});
t('every item has a status of ok/check/na, a reason, and a Google docs link', () => {
  const r = c.runChecks({ jsonLdTexts: [JSON.stringify(goodProduct)], links: fullLinks, text: '', ogPrice: '1', ogType: 'product', path: '/products/a', imgs: [{ alt: '' }] });
  for (const i of r.items) {
    assert.ok(['ok', 'check', 'na'].includes(i.status), i.id);
    assert.ok(i.reason && i.reason.length > 3, i.id);
    assert.ok(Object.values(c.DOCS).includes(i.ref), i.id);
  }
});
t('notice text is the required fixed sentence', () => {
  assert.equal(c.NOTICE, 'Free, open-source check of this page and the store\'s own policy pages. Not affiliated with Google or Shopify. It does not guarantee Merchant Center approval or reinstatement. Nothing is sent to the author or anyone else.');
});

/* ---- policy page contents ---- */
const shipRule = { id: 'shipping', label: 'Shipping policy', ref: c.DOCS.misrep };
const refundRule = { id: 'refund', label: 'Refund / return policy', ref: c.DOCS.editorial };
const realPolicy = 'We ship within 2 business days. Orders arrive in 5 to 7 days. Returns are accepted for 30 days after delivery.';
t('analyzePolicyText: empty body -> length 0, no placeholders', () => {
  assert.deepEqual(c.analyzePolicyText(''), { length: 0, placeholders: [] });
  assert.deepEqual(c.analyzePolicyText(null), { length: 0, placeholders: [] });
  assert.equal(c.analyzePolicyText('   \n\t  ').length, 0);
});
t('analyzePolicyText: whitespace is collapsed and trimmed', () => {
  assert.equal(c.analyzePolicyText('  a   b \n\n c  ').length, 5);
});
t('analyzePolicyText: real text has no placeholders', () => {
  const r = c.analyzePolicyText(realPolicy);
  assert.equal(r.placeholders.length, 0); assert.ok(r.length > 40);
});
t('analyzePolicyText: [LINK TO REFUND POLICY] is found', () => {
  const r = c.analyzePolicyText('See our refund terms at [LINK TO REFUND POLICY] for details.');
  assert.deepEqual(r.placeholders, ['[LINK TO REFUND POLICY]']);
});
t('analyzePolicyText: [LINK TO PRIVACY POLICY], [INSERT ...] and [STORE NAME] are found', () => {
  const r = c.analyzePolicyText('[STORE NAME] respects privacy. [INSERT EMAIL HERE] or [LINK TO PRIVACY POLICY].');
  assert.deepEqual(r.placeholders.slice().sort(), ['[INSERT EMAIL HERE]', '[LINK TO PRIVACY POLICY]', '[STORE NAME]']);
});
t('analyzePolicyText: lowercase brackets such as [optional] are not flagged', () => {
  assert.equal(c.analyzePolicyText('Pay by card [optional] or [see below] or [Note].').placeholders.length, 0);
});
t('analyzePolicyText: [1], [X] and [a] are not flagged', () => {
  assert.equal(c.analyzePolicyText('Footnote [1] and [X] and [12] and [A].').placeholders.length, 0);
});
t('analyzePolicyText: generic all-caps rule catches [RETURN WINDOW IN DAYS]', () => {
  assert.deepEqual(c.analyzePolicyText('Returns within [RETURN WINDOW IN DAYS] days.').placeholders, ['[RETURN WINDOW IN DAYS]']);
});
t('analyzePolicyText: duplicates are removed and the list is capped at 5', () => {
  const dup = c.analyzePolicyText('[STORE NAME] [STORE NAME] [STORE NAME]');
  assert.deepEqual(dup.placeholders, ['[STORE NAME]']);
  const many = c.analyzePolicyText('[INSERT A] [INSERT B] [INSERT C] [INSERT D] [INSERT E] [INSERT F] [INSERT G]');
  assert.equal(many.placeholders.length, 5);
});
t('evaluatePolicyPage: HTTP 404 -> check with the status in the reason', () => {
  const r = c.evaluatePolicyPage(shipRule, { status: 404, finalSameOrigin: true, text: '' });
  assert.equal(r.status, 'check'); assert.equal(r.reason, 'The link goes to a page that returned HTTP 404.');
  assert.equal(r.group, 'Policy page contents'); assert.equal(r.id, 'content-shipping');
});
t('evaluatePolicyPage: heading-only page -> check, little or no text', () => {
  const r = c.evaluatePolicyPage(shipRule, { status: 200, finalSameOrigin: true, text: ' Shipping policy ' });
  assert.equal(r.status, 'check');
  assert.equal(r.reason, 'The page loads, but its HTML has little or no policy text (15 characters). If the text is added by an embed or script (for example Termly), open the page to confirm visitors can see it.');
});
t('evaluatePolicyPage: length boundary 39 -> check, 40 -> ok', () => {
  assert.equal(c.evaluatePolicyPage(shipRule, { status: 200, finalSameOrigin: true, text: 'a'.repeat(39) }).status, 'check');
  assert.equal(c.evaluatePolicyPage(shipRule, { status: 200, finalSameOrigin: true, text: 'a'.repeat(40) }).status, 'ok');
});
t('evaluatePolicyPage: placeholder text -> check naming the placeholder', () => {
  const r = c.evaluatePolicyPage(refundRule, { status: 200, finalSameOrigin: true, text: realPolicy + ' [LINK TO REFUND POLICY]' });
  assert.equal(r.status, 'check');
  assert.equal(r.reason, 'Template text still present, for example: [LINK TO REFUND POLICY].');
});
t('evaluatePolicyPage: real text -> ok with character count', () => {
  const r = c.evaluatePolicyPage(refundRule, { status: 200, finalSameOrigin: true, text: realPolicy });
  assert.equal(r.status, 'ok');
  assert.equal(r.reason, 'Policy text found (' + realPolicy.length + ' characters), no template placeholders spotted.');
});
t('evaluatePolicyPage: blocked or failed fetch -> na', () => {
  for (const res of [{ failed: true }, { blocked: true }, {}, undefined, { status: 0 }]) {
    const r = c.evaluatePolicyPage(shipRule, res);
    assert.equal(r.status, 'na');
    assert.ok(/Could not load this page from the checker/.test(r.reason));
  }
});
t('evaluatePolicyPage: redirect to another site -> na, text is not judged', () => {
  const r = c.evaluatePolicyPage(shipRule, { status: 200, finalSameOrigin: false, text: '' });
  assert.equal(r.status, 'na');
});
t('evaluatePolicyPage: other non-200 status -> check', () => {
  assert.equal(c.evaluatePolicyPage(shipRule, { status: 500, finalSameOrigin: true, text: '' }).reason, 'The link goes to a page that returned HTTP 500.');
});
t('evaluatePolicyPage: skipped target -> na with the given reason; items use known refs', () => {
  const r = c.evaluatePolicyPage(shipRule, { skipped: 'Nothing to open.' });
  assert.equal(r.status, 'na'); assert.equal(r.reason, 'Nothing to open.');
  assert.ok(Object.values(c.DOCS).includes(r.ref));
});
t('policyContentTargets: store link used; third-party and Shopify-hosted links give no href', () => {
  const links = [
    { href: '/policies/refund-policy', text: 'Refund policy' },
    { href: 'https://hcaptcha.com/privacy', text: 'Privacy' },
    { href: 'https://www.shopify.com/legal/terms', text: 'Terms of Service' }
  ];
  const t4 = c.policyContentTargets(links, 'shop.example.com');
  assert.deepEqual(t4.map((x) => x.rule.id), ['refund', 'shipping', 'privacy', 'terms']);
  assert.equal(t4[0].href, '/policies/refund-policy');
  assert.equal(t4[1].href, ''); assert.equal(t4[2].href, '');
  assert.equal(t4[3].standardPath, '/policies/terms-of-service');
});

t('detectPolicyEmbed: Termly embed div and script are detected', () => {
  assert.equal(c.detectPolicyEmbed('<main><div name="termly-embed" data-id="x"></div><script src="https://app.termly.io/embed-policy.min.js"></script></main>'), 'Termly');
  assert.equal(c.detectPolicyEmbed('<div class="iubenda-embed"></div>'), 'iubenda');
  assert.equal(c.detectPolicyEmbed('<div data-getterms="1"></div>'), 'GetTerms');
  assert.equal(c.detectPolicyEmbed('<div data-termageddon="1"></div>'), 'Termageddon');
  assert.equal(c.detectPolicyEmbed('<div class="termsfeed-embed"></div>'), 'TermsFeed');
});
t('detectPolicyEmbed: the word Termly in a sentence is not an embed', () => {
  assert.equal(c.detectPolicyEmbed('<p>We once looked at Termly and iubenda before writing this policy ourselves.</p>'), '');
  assert.equal(c.detectPolicyEmbed(''), ''); assert.equal(c.detectPolicyEmbed(null), '');
});
t('evaluatePolicyPage: empty page with a Termly embed -> na naming Termly', () => {
  const r = c.evaluatePolicyPage(refundRule, { status: 200, finalSameOrigin: true, text: 'Privacy Policy', embed: 'Termly' });
  assert.equal(r.status, 'na');
  assert.equal(r.reason, 'Policy text is loaded by a third-party embed (Termly), which this check cannot read; open the page to confirm the text shows.');
});
t('evaluatePolicyPage: long real text is judged normally even if an embed script is on the page', () => {
  const r = c.evaluatePolicyPage(refundRule, { status: 200, finalSameOrigin: true, text: realPolicy.repeat(3), embed: 'Termly' });
  assert.equal(r.status, 'ok');
});
t('evaluatePolicyPage: real text that mentions Termly in a sentence (no embed) is ok', () => {
  const txt = realPolicy + ' Our cookie banner is provided by Termly.';
  assert.equal(c.evaluatePolicyPage(refundRule, { status: 200, finalSameOrigin: true, text: txt, embed: c.detectPolicyEmbed('<p>' + txt + '</p>') }).status, 'ok');
});
t('evaluatePolicyPage: short page without an embed still says Check', () => {
  assert.equal(c.evaluatePolicyPage(refundRule, { status: 200, finalSameOrigin: true, text: '', embed: '' }).status, 'check');
});
t('analyzePolicyText: [Your Contact Information] (mixed case) is found', () => {
  assert.deepEqual(c.analyzePolicyText('Questions? Write to [Your Contact Information].').placeholders, ['[Your Contact Information]']);
});
t('analyzePolicyText: [insert return address] (lowercase) is found', () => {
  assert.deepEqual(c.analyzePolicyText('Send returns to [insert return address] please.').placeholders, ['[insert return address]']);
});
t('analyzePolicyText: [email protected] (obfuscated address) and ordinary bracketed words are not flagged', () => {
  assert.equal(c.analyzePolicyText('Write to [email protected] [optional] [see below] [1] [X] [Note] [names of items]').placeholders.length, 0);
});
t('analyzePolicyText: mixed-case duplicates of the same token collapse', () => {
  assert.deepEqual(c.analyzePolicyText('[Store Name] and [Store Name]').placeholders, ['[Store Name]']);
});
/* ---- two versions of one policy (L040) ---- */
const privacyRule = { id: 'privacy', label: 'Privacy policy', ref: c.DOCS.editorial };
const ok200 = (text) => ({ status: 200, finalSameOrigin: true, text, embed: '' });
const loopFooter = 'Privacy Policy. ' + 'We collect your name, address and order details to fulfil orders. '.repeat(40) +
  'We share your Personal Information with third parties to help us use your Personal Information, as described above.';
const loopStd = 'Privacy policy. We respect your privacy and do not share your information with anyone.';
const privInfo = { footerPath: '/pages/privacy', standardPath: '/policies/privacy-policy' };
t('comparePolicyVersions: Loop-type pair (long footer page that shares, one-line built-in that does not) -> check', () => {
  const r = c.comparePolicyVersions(privacyRule, privInfo, ok200(loopFooter), ok200(loopStd));
  assert.ok(r); assert.equal(r.status, 'check'); assert.equal(r.id, 'versions-privacy');
  assert.ok(r.reason.startsWith('Your footer links to /pages/privacy ('));
  assert.ok(r.reason.includes("Shopify's built-in privacy policy page /policies/privacy-policy also exists (" + loopStd.length + ' characters).'));
  assert.ok(r.reason.includes('the built-in page has "do not share"'));
  assert.ok(r.reason.endsWith('Visitors may find either one, and they may say different things. Open both and consider making them match.'));
});
t('comparePolicyVersions: same text in both places -> null', () => {
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(loopFooter), ok200('  ' + loopFooter + ' ')), null);
});
t('comparePolicyVersions: built-in page 404 or empty -> null', () => {
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(loopFooter), { status: 404, finalSameOrigin: true, text: '' }), null);
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(loopFooter), ok200('')), null);
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(loopFooter), { failed: true }), null);
});
t('comparePolicyVersions: footer already points to the built-in path (or redirects there) -> null', () => {
  assert.equal(c.comparePolicyVersions(privacyRule, { footerPath: '/policies/privacy-policy/', standardPath: '/policies/privacy-policy' }, ok200(loopFooter), ok200(loopStd)), null);
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(loopFooter), Object.assign(ok200(loopStd), { finalPath: '/pages/privacy' })), null);
});
t('comparePolicyVersions: similar length, different wording, no sharing words -> null', () => {
  const a = 'We use your details to ship orders and answer questions. '.repeat(20);
  const b = 'Your details are used for shipping and for replying to messages. '.repeat(18);
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(a), ok200(b)), null);
});
t('comparePolicyVersions: both versions say "do not sell" and "may share" -> no sharing note, null at similar length', () => {
  const a = 'We do not sell your data. We may share it with our shipping partner. '.repeat(15);
  const b = 'We do not sell personal information. We may share it with payment processors. '.repeat(14);
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(a), ok200(b)), null);
});
/* 22:15 review: "will not share" / curly "don’t share" / "does not share" are negative; "do not sell" alone is not a sharing statement. */
const longPad = 'We collect your name, address and order details to fulfil orders. '.repeat(10);
t('comparePolicyVersions: "will not share" vs "do not sell" (both say no) -> null', () => {
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(longPad + 'We will not share your information with any third parties.'), ok200(longPad + 'We do not sell your personal information.')), null);
});
t('comparePolicyVersions: curly "don\u2019t share ... third parties" and "Acme does not share" vs "do not sell" -> null', () => {
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(longPad + 'We don\u2019t share your data with third parties.'), ok200(longPad + 'We do not sell your data.')), null);
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(longPad + 'Acme does not share your data with third parties.'), ok200(longPad + 'We do not sell your data.')), null);
});
t('comparePolicyVersions: "do not sell" vs "we share with service providers" -> null (not opposite)', () => {
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(longPad + 'We do not sell your personal information.'), ok200(longPad + 'We share your Personal Information with service providers like Shopify.')), null);
});
t('comparePolicyVersions: "do not sell or share" vs "we may share ... third parties" -> still check', () => {
  const r = c.comparePolicyVersions(privacyRule, privInfo, ok200(longPad + 'We may share your details with third parties for marketing.'), ok200(longPad + 'We do not sell or share your personal information.'));
  assert.ok(r); assert.equal(r.status, 'check'); assert.ok(r.reason.includes('the built-in page has "do not sell or share"'));
});
t('comparePolicyVersions: script-embedded footer policy is not judged by length -> null', () => {
  assert.equal(c.comparePolicyVersions(refundRule, { footerPath: '/pages/returns', standardPath: '/policies/refund-policy' },
    Object.assign(ok200('Returns are accepted within 30 days of delivery. '.repeat(60)), { embed: 'Termly' }), ok200('Refunds within 14 days. '.repeat(5))), null);
});
t('comparePolicyVersions: refund page 3000 chars vs built-in stub 119 chars -> check about length', () => {
  const r = c.comparePolicyVersions(refundRule, { footerPath: '/pages/returns', standardPath: '/policies/refund-policy' },
    ok200('Returns are accepted within 30 days of delivery. '.repeat(60)), ok200('Refunds within 14 days. '.repeat(5)));
  assert.ok(r.reason.includes('/policies/refund-policy also exists (119 characters).'));
  assert.ok(r); assert.equal(r.status, 'check'); assert.ok(r.reason.includes('The built-in page is much shorter than the footer page.'));
});
t('comparePolicyVersions: sharing words in refund policy do not trigger the privacy rule', () => {
  const a = 'We do not share refunds for sale items. '.repeat(20);
  const b = 'We share the cost with third party carriers for returns. '.repeat(16);
  assert.equal(c.comparePolicyVersions(refundRule, { footerPath: '/pages/returns', standardPath: '/policies/refund-policy' }, ok200(a), ok200(b)), null);
});
t('comparePolicyVersions: short built-in page carrying an embed -> null', () => {
  assert.equal(c.comparePolicyVersions(privacyRule, privInfo, ok200(loopFooter), Object.assign(ok200(loopStd), { embed: 'Termly' })), null);
});
t('comparePolicyVersions: short custom page (50 chars, app-filled) vs 1163-char built-in (Allbirds case) -> null', () => {
  assert.equal(c.comparePolicyVersions(refundRule, { footerPath: '/pages/returns-exchanges', standardPath: '/policies/refund-policy' },
    ok200('Returns & Exchanges. Start your return online here.'), ok200('You have 30 days after receiving your item to request a return. '.repeat(18))), null);
});
t('comparePolicyVersions: long custom page vs 391-char built-in refund text (Loop refund case) -> null', () => {
  const std = 'Yarn may be returned for store credit within 120 days of purchase if unused. '.repeat(6).slice(0, 391);
  assert.equal(c.comparePolicyVersions(refundRule, { footerPath: '/pages/policies', standardPath: '/policies/refund-policy' }, ok200('Store Policies. Unused yarn may be returned within 120 days. '.repeat(65)), ok200(std)), null);
});
console.log('\nTotal: ' + (pass + fail) + '  Passed: ' + pass + '  Failed: ' + fail);
process.exit(fail ? 1 : 0);
