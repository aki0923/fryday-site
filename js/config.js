/*
 * Fryday — site configuration.
 * Edit only the values below. Every value marked "ВСТАВЬТЕ_СЮДА" must be filled
 * by the owner; until then the site hides the related block (address, map, etc.).
 */
window.FRYDAY_CONFIG = {
  // Google Apps Script web app URL (request 2 / backend).
  // Apps Script → Deploy → Manage deployments → Web app → URL. It ends with "/exec".
  API_URL: "https://script.google.com/macros/s/AKfycby-lmcXWolKI7V2HcJvXViOrXcfNKq2eVdXcYu_IhZrdLce-olV5K2AFwWsZV77YQdMfA/exec",

  // Cloudflare dashboard → Turnstile → Add widget (Managed) → "Site Key".
  // Add your Pages domain (e.g. fryday.pages.dev) to the widget's hostname list.
  // The SECRET key goes into Apps Script, never here.
  TURNSTILE_SITE_KEY: "ВСТАВЬТЕ_СЮДА",

  // WhatsApp number for the "Написать в WhatsApp" button: digits only, no "+", no spaces.
  // Example: 996705515151. Must be the same number that receives orders.
  WA_PHONE: "996555112762",

  // Brand name as shown on the site.
  BRAND: "Fryday",

  // Street address as customers should read it, e.g. "г. Бишкек, ул. Киевская, 95".
  ADDRESS: "Г. Бишкек проспект Чынгыза Айтматова, 299в, ТРЦ «Ала-Арча»",

  // Opening hours as text, e.g. "Ежедневно с 11:00 до 23:00".
  // If left as "ВСТАВЬТЕ_СЮДА", the site builds this text from the hours in the Google Sheet.
  HOURS_TEXT: "Ежедневно с 10:00 до 22:00",

  // Phone number as shown to people, e.g. "+996 705 515 151". Used for the "Позвонить" link.
  PHONE_DISPLAY: "+996 555 112 762",

  // Full Instagram profile link, e.g. "https://instagram.com/fryday.kg".
  INSTAGRAM_URL: "https://www.instagram.com/fry_daykg/",

  // Map link: open the place in 2GIS or Google Maps → Share → copy link.
  MAP_URL: "https://go.2gis.com/cloTG"
};
