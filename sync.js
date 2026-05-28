require('dotenv').config();
const https = require('https');
const fs    = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const MARCA_ID   = 1;
const BATCH_SIZE = 100;

// ─── PASO 1: Descargar catálogo fresco → nice_catalogo_nuevo.json ─────────────

const ENDPOINT = 'jqtivi-x7.myshopify.com';
const TOKEN    = '7783898d87a6a1b137d47ae844b95126';

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
              node { sku title price { amount } }
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
        'Content-Length': Buffer.byteLength(body),
      },
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

async function descargar() {
  console.log('━━━ PASO 1 · Descargando catálogo fresco de Shopify ━━━\n');
  const rows   = [];
  let cursor   = null;
  let page     = 1;

  while (true) {
    process.stdout.write(`  Página ${page}... `);
    const json = await post(QUERY(cursor));

    if (json.errors) {
      console.error('Error Shopify:', json.errors);
      break;
    }

    const data = json.data.products;
    for (const { node: p } of data.edges) {
      const imagen    = p.images.edges[0]?.node?.url || '';
      const variantes = p.variants.edges;
      for (const { node: v } of variantes) {
        if (!v.sku) continue;
        rows.push({
          sku:       v.sku,
          nombre:    variantes.length === 1 ? p.title : `${p.title} — ${v.title}`,
          categoria: p.productType || '',
          precio:    parseFloat(v.price.amount),
          imagen,
        });
      }
    }

    console.log(`${data.edges.length} prods (total: ${rows.length})`);
    if (!data.pageInfo.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }

  fs.writeFileSync('nice_catalogo_nuevo.json', JSON.stringify(rows, null, 2), 'utf8');
  console.log(`\n  ✓ ${rows.length} productos guardados en nice_catalogo_nuevo.json\n`);
  return rows;
}

// ─── PASO 2: Comparar nuevo vs acumulado → faltantes.json ────────────────────

function compararYGenerar(nuevo) {
  console.log('━━━ PASO 2 · Comparando con nice_catalogo.json ━━━\n');

  // Si todavía no existe el acumulado, todos son faltantes
  let acumulado = [];
  if (fs.existsSync('nice_catalogo.json')) {
    acumulado = JSON.parse(fs.readFileSync('nice_catalogo.json', 'utf8'));
  } else {
    console.log('  nice_catalogo.json no existe aún → todos son nuevos\n');
  }

  const skusAcumulados = new Set(acumulado.map(p => p.sku));
  const faltantes      = nuevo.filter(p => !skusAcumulados.has(p.sku));

  console.log(`  Acumulado (nice_catalogo.json) : ${acumulado.length} productos`);
  console.log(`  Descargados (nuevo)            : ${nuevo.length} productos`);
  console.log(`  Faltantes (a inyectar)         : ${faltantes.length} productos\n`);

  if (faltantes.length === 0) {
    console.log('  ✓ Sin productos nuevos. Nada que inyectar.\n');
    return { faltantes: [], acumulado };
  }

  fs.writeFileSync('faltantes.json', JSON.stringify(faltantes, null, 2), 'utf8');
  console.log(`  ✓ faltantes.json generado con ${faltantes.length} productos\n`);
  return { faltantes, acumulado };
}

// ─── PASO 3: Resolver categorías ─────────────────────────────────────────────

async function resolverCategorias(productos) {
  const { rows } = await pool.query(
    'SELECT id, nombre FROM public.categorias WHERE marca_id = $1',
    [MARCA_ID]
  );
  const mapa = new Map(rows.map(r => [r.nombre.toUpperCase(), r.id]));

  const nuevas = [
    ...new Set(
      productos
        .map(p => (p.categoria || '').trim().toUpperCase())
        .filter(c => c && !mapa.has(c))
    ),
  ];

  if (nuevas.length) {
    console.log(`  Creando ${nuevas.length} categoría(s) nueva(s): ${nuevas.join(', ')}`);
    for (const nombre of nuevas) {
      const res = await pool.query(
        `INSERT INTO public.categorias (nombre, marca_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id`,
        [nombre, MARCA_ID]
      );
      if (res.rows[0]) {
        mapa.set(nombre, res.rows[0].id);
      } else {
        const r2 = await pool.query(
          'SELECT id FROM public.categorias WHERE nombre = $1 AND marca_id = $2',
          [nombre, MARCA_ID]
        );
        if (r2.rows[0]) mapa.set(nombre, r2.rows[0].id);
      }
    }
    console.log();
  }

  return mapa;
}

// ─── PASO 4: Inyectar faltantes → DB ─────────────────────────────────────────

async function inyectar(faltantes) {
  console.log('━━━ PASO 3 · Inyectando faltantes en la base de datos ━━━\n');

  const mapaCategoria = await resolverCategorias(faltantes);
  let insertados  = 0;
  let actualizados = 0;
  let errores     = 0;

  for (let i = 0; i < faltantes.length; i += BATCH_SIZE) {
    const batch = faltantes.slice(i, i + BATCH_SIZE);

    const placeholders = batch.map((_, idx) => {
      const b = idx * 7;
      return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7})`;
    }).join(', ');

    const values = batch.flatMap(item => {
      const categoriaId = mapaCategoria.get((item.categoria || '').trim().toUpperCase()) ?? null;
      return [item.sku, item.nombre, item.precio, item.imagen, categoriaId, MARCA_ID, true];
    });

    const query = `
      INSERT INTO public.catalogo_maestro
        (sku, nombre, precio_sugerido, ruta_imagen, categoria_id, marca_id, estado)
      VALUES ${placeholders}
      ON CONFLICT (sku)
      DO UPDATE SET
        nombre          = EXCLUDED.nombre,
        precio_sugerido = EXCLUDED.precio_sugerido,
        ruta_imagen     = EXCLUDED.ruta_imagen,
        categoria_id    = COALESCE(EXCLUDED.categoria_id, catalogo_maestro.categoria_id),
        marca_id        = EXCLUDED.marca_id,
        estado          = true,
        creado_por      = NULL
      RETURNING xmax;
    `;

    try {
      const result = await pool.query(query, values);
      result.rows.forEach(row => {
        if (row.xmax === '0') insertados++;
        else actualizados++;
      });
    } catch (err) {
      console.error(`\n  Batch ${i}–${i + batch.length} | Error: ${err.message}`);
      for (const item of batch) {
        try {
          const categoriaId = mapaCategoria.get((item.categoria || '').trim().toUpperCase()) ?? null;
          await pool.query(
            `INSERT INTO public.catalogo_maestro
               (sku, nombre, precio_sugerido, ruta_imagen, categoria_id, marca_id, estado)
             VALUES ($1, $2, $3, $4, $5, $6, true)
             ON CONFLICT (sku)
             DO UPDATE SET
               nombre          = EXCLUDED.nombre,
               precio_sugerido = EXCLUDED.precio_sugerido,
               ruta_imagen     = EXCLUDED.ruta_imagen,
               categoria_id    = COALESCE(EXCLUDED.categoria_id, catalogo_maestro.categoria_id),
               marca_id        = EXCLUDED.marca_id,
               estado          = true,
               creado_por      = NULL`,
            [item.sku, item.nombre, item.precio, item.imagen, categoriaId, MARCA_ID]
          );
          actualizados++;
        } catch (itemErr) {
          console.error(`  SKU: ${item.sku} | ${itemErr.message}`);
          errores++;
        }
      }
    }

    process.stdout.write(`\r  Progreso: ${Math.min(i + BATCH_SIZE, faltantes.length)}/${faltantes.length}`);
  }

  console.log(`\n\n  ✓ Insertados nuevos : ${insertados}`);
  console.log(`  ✓ Actualizados      : ${actualizados}`);
  if (errores) console.log(`  ✗ Errores           : ${errores}`);
  console.log();
}

// ─── PASO 5: Merge → actualizar nice_catalogo.json ───────────────────────────

function merge(acumulado, nuevo) {
  console.log('━━━ PASO 4 · Actualizando nice_catalogo.json ━━━\n');

  // El nuevo tiene prioridad: si un SKU ya existe se actualiza con los datos frescos
  const mapaFinal = new Map(acumulado.map(p => [p.sku, p]));
  for (const p of nuevo) mapaFinal.set(p.sku, p);

  const resultado = [...mapaFinal.values()];
  fs.writeFileSync('nice_catalogo.json', JSON.stringify(resultado, null, 2), 'utf8');

  const agregados = resultado.length - acumulado.length;
  console.log(`  Antes  : ${acumulado.length} productos`);
  console.log(`  Después: ${resultado.length} productos (+${agregados} nuevos)`);
  console.log('\n  ✓ nice_catalogo.json actualizado y listo para la próxima corrida\n');

  // Limpiar archivos temporales
  if (fs.existsSync('nice_catalogo_nuevo.json')) fs.unlinkSync('nice_catalogo_nuevo.json');
  if (fs.existsSync('faltantes.json'))           fs.unlinkSync('faltantes.json');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔄 SYNC CATÁLOGO NICE → DB\n');

  const nuevo              = await descargar();
  const { faltantes, acumulado } = compararYGenerar(nuevo);

  if (faltantes.length > 0) {
    await inyectar(faltantes);
  }

  merge(acumulado, nuevo);

  console.log('✅ Sync completado.\n');
  await pool.end();
}

main().catch(async err => {
  console.error('\n❌ Error inesperado:', err.message);
  await pool.end();
  process.exit(1);
});
