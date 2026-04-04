const axios = require('axios');
(async () => {
    try {
        const apiKey = 'gk_26f600af26406547da9d3c70764bffdc13cbe47f209aaeb3';
        const doc = '00000000000';
        const res = await axios.post('https://ggpixapi.com/api/v1/pix/in', {
            amountCents: 500,
            description: 'Depósito Plataforma',
            payerName: 'Jogador',
            payerDocument: doc,
            externalId: 'dep-12345-' + Date.now()
        }, { headers: { 'X-API-Key': apiKey } });
        console.log(res.data);
    } catch (err) {
        console.log(err.response?.data || err.message);
    }
})();
