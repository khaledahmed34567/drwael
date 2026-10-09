// Firebase Cloud Messaging Service Worker
importScripts('https://www.gstatic.com/firebasejs/12.18.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.18.0/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyDwo9ylUI7cq7DodekA0vM7iMw-6COp3BI",
  authDomain: "saemad-8a204.firebaseapp.com",
  projectId: "saemad-8a204",
  storageBucket: "saemad-8a204.firebasestorage.app",
  messagingSenderId: "676932025599",
  appId: "1:676932025599:web:0076ca1cabc132883a60ca"
};

firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  const title = payload.notification?.title || 'اسأل دكتور وائل';
  const options = {
    body: payload.notification?.body || 'تمت الإجابة على سؤالك بواسطة دكتور وائل!',
    icon: payload.notification?.icon || '/favicon.ico',
    badge: '/favicon.ico',
    dir: 'rtl',
    lang: 'ar',
    data: payload.data || {},
    actions: [
      { action: 'open_question', title: 'عرض الإجابة' }
    ]
  };

  self.registration.showNotification(title, options);
});

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  if (event.data) {
    try {
      const data = event.data.json();
      const title = data.notification?.title || data.title || 'اسأل دكتور وائل';
      const options = {
        body: data.notification?.body || data.body || 'تمت الإجابة على سؤالك!',
        icon: data.notification?.icon || '/favicon.ico',
        badge: '/favicon.ico',
        dir: 'rtl',
        lang: 'ar',
        data: data.data || data
      };
      event.waitUntil(self.registration.showNotification(title, options));
    } catch(e) {
      const text = event.data.text();
      event.waitUntil(self.registration.showNotification('اسأل دكتور وائل', {
        body: text,
        dir: 'rtl',
        lang: 'ar'
      }));
    }
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const qid = event.notification.data?.qid;
  const targetUrl = qid ? '/#/q/' + qid : '/#/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let client of windowClients) {
        if ('focus' in client) {
          if (client.url.includes(self.location.origin)) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
