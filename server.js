const express = require('express');
const fs = require('fs');
const app = express();
app.use(express.json());

app.get('/settings', (req, res) => {
  res.sendFile(__dirname + '/settings.json'); // ✅ safe and local
});

app.post('/settings', (req, res) => {
  fs.writeFileSync(__dirname + '/settings.json', JSON.stringify(req.body, null, 2));
  res.json({ message: 'Settings saved!' });
});

app.listen(process.env.PORT || 3000, () => {
  console.log('✅ Backend running');
});
