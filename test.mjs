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
  assert.equal(c.NOTICE, 'Free, open-source check of this page only. Not affiliated with Google or Shopify. It does not guarantee Merchant Center approval or reinstatement. Nothing is sent anywhere.');
});

console.log('\nTotal: ' + (pass + fail) + '  Passed: ' + pass + '  Failed: ' + fail);
process.exit(fail ? 1 : 0);
