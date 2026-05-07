const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function enviarCorreo({ to, subject, html }) {
  return transporter.sendMail({
    from: `"APP RUNT" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html
  });
}

module.exports = { enviarCorreo };