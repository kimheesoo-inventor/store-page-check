# Store Page Check

A free, open-source bookmarklet that reads the store page you are on and lists what to look at before a Google Merchant Center review. It reads the page it runs on and the store's own policy pages (see Limits). It sends nothing to the author or anyone else.

Not affiliated with Google or Shopify. It does not guarantee Merchant Center approval or reinstatement.

## What it checks

- Policy links: refund/return, shipping, privacy, terms, contact (Shopify default paths recognized)
- Policy page contents: whether the refund, shipping, privacy and terms pages are empty (heading only), return an error, or still contain template text such as `[LINK TO REFUND POLICY]`
- Contact details: email and phone visible on the page, email links whose address cannot work, such as two @ signs, template sample addresses such as support@example.com or contact@yourstore.com, and template sample phone numbers such as (123) 456-7890 or 555-555-5555 (address is left for you to check)
- Product data, read from JSON-LD and/or microdata (`itemtype` schema.org/Product): name, image, price, currency, availability, brand, identifier, shippingDetails, hasMerchantReturnPolicy. The panel says which format(s) were found; if both exist, JSON-LD values are used and gaps are filled from microdata.
- Product price vs `og:price:amount`
- Images with missing or empty alt text

Each item shows OK, Check, or N/A, with a one-line reason and a Google documentation link.

## Files

- `checker.js` - the bookmarklet source (judgement functions are separate from DOM code)
- `build.mjs` - builds `bookmarklet.txt` and updates the links in `index.html`
- `bookmarklet.txt` - the one-line `javascript:` URL
- `index.html` - single-file landing page (no external CSS/JS/fonts)
- `test.mjs` - unit tests for the judgement functions

## Develop

Requires Node.js (built-in modules only, no dependencies).

```
node test.mjs
node build.mjs
```

## Limits

- It reads the page it runs on, and also loads the store's own policy pages (same site, read only, up to four requests) to check whether they are empty or still contain template text. Nothing is sent to the author or any third party. If a store's security settings block these requests, those items show N/A and you should open the pages yourself.
- Policy text that an embed or script adds after the page opens (for example a Termly policy) is not seen. For known embed services (Termly, iubenda, GetTerms, Termageddon, TermsFeed) the item shows N/A; for other scripts a page can show Check even though visitors see the text. Template text is matched by common words such as `[Your ...]`, `[Insert ...]` or `[LINK TO ...]` in any letter case, so differently worded placeholders can be missed.
- Structured data: JSON-LD and microdata are read. RDFa and microdata that points to elements elsewhere on the page (`itemref`) are not.
- Sites with a strict Content Security Policy may block the panel.
- Phone/email detection is pattern-based and can miss or misread.
- Results are hints for your own review, not a verdict.

## License

MIT, see `LICENSE`.
