require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function comparar() {
  const archivoFuente = process.argv[2] || 'nice_catalogo.json';

  if (!fs.existsSync(archivoFuente)) {
    console.error(`No se encontró el archivo: ${archivoFuente}`);
    process.exit(1);
  }

  const catalogo = JSON.parse(fs.readFileSync(archivoFuente, 'utf8'))
    .filter(item => item.sku);

  console.log(`Fuente       : ${archivoFuente}`);
  console.log(`Total en JSON: ${catalogo.length} productos\n`);

  // Traer todos los SKUs que ya existen en la DB (una sola consulta)
  const { rows } = await pool.query('SELECT sku FROM public.catalogo_maestro');
  const skusEnDB = new Set(rows.map(r => r.sku));

  console.log(`Ya en DB     : ${skusEnDB.size} productos`);

  // Separar pendientes (no están en DB) de ya existentes
  const pendientes  = catalogo.filter(item => !skusEnDB.has(item.sku));
  const yaExistentes = catalogo.filter(item =>  skusEnDB.has(item.sku));

  console.log(`Pendientes   : ${pendientes.length} productos`);
  console.log(`Ya existentes: ${yaExistentes.length} productos\n`);

  if (pendientes.length === 0) {
    console.log('✓ La base de datos ya está al día con el catálogo. No se generó skus_pendientes.json');
    await pool.end();
    return;
  }

  fs.writeFileSync('skus_pendientes.json', JSON.stringify(pendientes, null, 2), 'utf8');
  console.log(`✓ skus_pendientes.json generado con ${pendientes.length} productos listos para inyectar`);
  console.log('\nSiguiente paso:');
  console.log('  node inyectar.js skus_pendientes.json');

  await pool.end();
}

comparar().catch(console.error);
