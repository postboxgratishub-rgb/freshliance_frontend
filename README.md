# Freshliance frontend

Static dashboard for the Freshliance device monitoring API. It can be deployed directly to Vercel or Netlify; no package installation or build command is required.

## Connect the backend

Open `config.js` and replace the placeholder with the public URL of the Render service:

```js
window.FRESHLANCE_CONFIG = Object.freeze({
  API_BASE_URL: 'https://your-service.onrender.com'
});
```

You can also set or change the backend for one browser after deployment by opening:

```text
https://your-frontend.example/?api=https://your-service.onrender.com
```

The address is saved in that browser. Open `?api=clear` to clear the saved override and return to `config.js`.

The backend must allow requests from the deployed frontend origin with CORS.

## Vercel

1. Import the GitHub repository.
2. Choose **Other** for the framework preset.
3. Leave the build command empty and use `.` as the output directory.
4. Deploy.

## Netlify

1. Import the GitHub repository.
2. Leave the build command empty.
3. Set the publish directory to `.`.
4. Deploy.
