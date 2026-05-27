require('dotenv').config();
const fs   = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const MARCA_ID     = 1;
const CATEGORIA_ID = 1;
const BATCH_SIZE   = 100;

async function inyectar() {
  const catalogo = JSON.parse(fs.readFileSync('skus_nuevos.json', 'utf8'))
    .filter(item => item.sku); // filtrar sin SKU

  console.log(`Inyectando ${catalogo.length} productos en batches de ${BATCH_SIZE}...\n`);

  let actualizados = 0;
  let insertados   = 0;
  let errores      = 0;

  for (let i = 0; i < catalogo.length; i += BATCH_SIZE) {
    const batch = catalogo.slice(i, i + BATCH_SIZE);

    // Construir un INSERT multi-fila dinámico
    const placeholders = batch.map((_, idx) => {
      const base = idx * 7;
      return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7})`;
    }).join(', ');

    const values = batch.flatMap(item => [
      item.sku,
      item.nombre,
      item.precio,
      item.imagen,
      item.categoria || '',
      CATEGORIA_ID,
      MARCA_ID,
    ]);

    const query = `
      INSERT INTO catalogo_maestro 
        (sku, nombre, precio_sugerido, ruta_imagen, categoria, categoria_id, marca_id)
      VALUES ${placeholders}
      ON CONFLICT (sku) 
      DO UPDATE SET categoria = EXCLUDED.categoria
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
        
        // Reintentar uno por uno para identificar el culpable
        for (const item of batch) {
            try {
            await pool.query(`
                INSERT INTO catalogo_maestro 
                (sku, nombre, precio_sugerido, ruta_imagen, categoria, categoria_id, marca_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (sku) 
                DO UPDATE SET categoria = CASE 
                WHEN EXCLUDED.categoria = '' THEN catalogo_maestro.categoria
                ELSE EXCLUDED.categoria
                END
            `, [item.sku, item.nombre, item.precio, item.imagen, item.categoria || '', CATEGORIA_ID, MARCA_ID]);
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

  console.log(`\n\n✓ Actualizados: ${actualizados}`);
  console.log(`✓ Insertados nuevos: ${insertados}`);
  console.log(`✗ Errores: ${errores}`);

  await pool.end();
}

inyectar().catch(console.error);