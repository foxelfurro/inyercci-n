require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const MARCA_ID   = 1;
const BATCH_SIZE = 100;

// ─── 1. Resuelve categoria (string) → categoria_id (int) ──────────────────────
// Carga todas las categorías existentes de la DB en un Map para no consultar
// en cada producto. Si llega una categoría nueva, la inserta y la agrega al Map.
async function resolverCategorias(productos) {
  // Cargar las ya existentes
  const { rows } = await pool.query(
    'SELECT id, nombre FROM public.categorias WHERE marca_id = $1',
    [MARCA_ID]
  );

  // Map con nombre en MAYÚSCULAS para comparación insensible a mayúsculas
  const mapaCategoria = new Map(rows.map(r => [r.nombre.toUpperCase(), r.id]));

  // Recolectar las categorías únicas que llegan en el JSON y aún no existen
  const nuevas = [
    ...new Set(
      productos
        .map(p => (p.categoria || '').trim().toUpperCase())
        .filter(c => c && !mapaCategoria.has(c))
    ),
  ];

  if (nuevas.length) {
    console.log(`\nCreando ${nuevas.length} categoría(s) nueva(s): ${nuevas.join(', ')}`);
    for (const nombre of nuevas) {
      const res = await pool.query(
        `INSERT INTO public.categorias (nombre, marca_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [nombre, MARCA_ID]
      );
      if (res.rows[0]) {
        mapaCategoria.set(nombre, res.rows[0].id);
      } else {
        // Otro proceso lo insertó justo antes (race condition improbable pero posible)
        const r2 = await pool.query(
          'SELECT id FROM public.categorias WHERE nombre = $1 AND marca_id = $2',
          [nombre, MARCA_ID]
        );
        if (r2.rows[0]) mapaCategoria.set(nombre, r2.rows[0].id);
      }
    }
  }

  return mapaCategoria;
}

// ─── 2. Inyección principal ───────────────────────────────────────────────────
async function inyectar() {
  const archivo = process.argv[2] || 'skus_nuevos.json';
  const catalogo = JSON.parse(fs.readFileSync(archivo, 'utf8'))
    .filter(item => item.sku);

  console.log(`Archivo: ${archivo}`);
  console.log(`Productos a inyectar: ${catalogo.length} (batches de ${BATCH_SIZE})\n`);

  // Paso previo: resolver / crear categorías
  const mapaCategoria = await resolverCategorias(catalogo);

  let actualizados = 0;
  let insertados   = 0;
  let errores      = 0;

  for (let i = 0; i < catalogo.length; i += BATCH_SIZE) {
    const batch = catalogo.slice(i, i + BATCH_SIZE);

    // Construir INSERT multi-fila (7 parámetros por fila)
    const placeholders = batch.map((_, idx) => {
      const b = idx * 7;
      return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7})`;
    }).join(', ');

    const values = batch.flatMap(item => {
      const catKey = (item.categoria || '').trim().toUpperCase();
      const categoriaId = mapaCategoria.get(catKey) ?? null;
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
      console.error(`\nBatch ${i}–${i + batch.length} | Error: ${err.message}`);

      // Reintentar uno por uno para identificar el producto culpable
      for (const item of batch) {
        try {
          const catKey = (item.categoria || '').trim().toUpperCase();
          const categoriaId = mapaCategoria.get(catKey) ?? null;
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

    const progreso = Math.min(i + BATCH_SIZE, catalogo.length);
    process.stdout.write(`\rProgreso: ${progreso}/${catalogo.length}`);
  }

  console.log(`\n\n✓ Insertados nuevos : ${insertados}`);
  console.log(`✓ Actualizados      : ${actualizados}`);
  console.log(`✗ Errores           : ${errores}`);

  await pool.end();
}

inyectar().catch(console.error);
