const https = require('https');
const fs = require('fs');

const ENDPOINT = 'jqtivi-x7.myshopify.com';
const TOKEN = '7783898d87a6a1b137d47ae844b95126';

const QUERY = (cursor) => JSON.stringify({
  query: `{
    products(first: 250${cursor ? `, after: "${cursor}"` : ''}) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title
          productType
          images(first: 1) { edges { node { url } } }
          variants(first: 50) {
            edges {
              node {
                sku
                title
                price { amount }
              }
            }
          }
        }
      }
    }
  }`
});

function post(body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ENDPOINT,
      path: '/api/2024-01/graphql.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': TOKEN,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchAll() {
  const rows = [];
  let cursor = null;
  let page = 1;

  console.log('Descargando catálogo NICE Online...\n');

  while (true) {
    process.stdout.write(`Página ${page}... `);
    const json = await post(QUERY(cursor));

    if (json.errors) {
      console.error('Error:', json.errors);
      break;
    }

    const data = json.data.products;

    for (const { node: p } of data.edges) {
      const imagen = p.images.edges[0]?.node?.url || '';
      const variantes = p.variants.edges;
      for (const { node: v } of variantes) {
        const nombre = variantes.length === 1
          ? p.title
          : `${p.title} — ${v.title}`;
        rows.push({
          sku:       v.sku || '',
          nombre,
          categoria: p.productType || '',
          precio:    parseFloat(v.price.amount),
          imagen
        });
      }
    }

    console.log(`${data.edges.length} productos (filas: ${rows.length})`);

    if (!data.pageInfo.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
    page++;
    await sleep(300);
  }

  return rows;
}

fetchAll().then(rows => {
  // Filtrar productos sin SKU antes de guardar
  const limpios = rows.filter(r => r.sku);
  fs.writeFileSync('nice_catalogo.json', JSON.stringify(limpios, null, 2), 'utf8');
  console.log(`\n✓ ${limpios.length} filas guardadas en nice_catalogo.json`);
  console.log('\nSiguiente paso: comparar contra la DB');
  console.log('  node comparar.js');
}).catch(console.error);