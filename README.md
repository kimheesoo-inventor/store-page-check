# Store Page Check

A free, open-source bookmarklet that reads the store page you are on and lists what to look at before a Google Merchant Center review. It checks only the current page. It makes no network requests and sends nothing anywhere.

Not affiliated with Google or Shopify. It does not guarantee Merchant Center approval or reinstatement.

## What it checks

- Policy links: refund/return, shipping, privacy, terms, contact (Shopify default paths recognized)
- Contact details: email and phone visible on the page (address is left for you to check)
- Product JSON-LD: name, image, price, currency, availability, brand, identifier, shippingDetails, hasMerchantReturnPolicy
- JSON-LD price vs `og:price:amount`
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

- Reads only the page it runs on; policy pages are not opened.
- Sites with a strict Content Security Policy may block the panel.
- Phone/email detection is pattern-based and can miss or misread.
- Results are hints for your own review, not a verdict.

## License

MIT, see `LICENSE`.
