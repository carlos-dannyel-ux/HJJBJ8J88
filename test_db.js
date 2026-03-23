const mysql = require('mysql2/promise');

async function test() {
    try {
        const connection = await mysql.createConnection({
            host: 'localhost',
            user: 'win30_user',
            password: 'Win30@Pass',
            database: '30win'
        });
        console.log('✅ Conexão com o Banco de Dados OK!');
        const [rows] = await connection.execute('SELECT 1 + 1 AS result');
        console.log('Result:', rows[0].result);
        await connection.end();
    } catch (err) {
        console.error('❌ Erro de conexão:', err.message);
    }
}

test();
