// OpenCV kommt aus vendor/opencv (schon von der Kartensuche geladen)
export default new Proxy({}, { get: (_, key) => window.cv[key] });
