self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let data={};
  try{data=event.data?event.data.json():{}}catch(e){data={title:'Mon Impasse',body:'Tienes una novedad.'}};
  const title=data.title||'Mon Impasse';
  const options={body:data.body||'Tienes una nueva notificación.',data:{url:data.url||'/admin.html'},tag:data.tag||'mon-impasse-order',renotify:true};
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const url=event.notification.data?.url||'/admin.html';
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const client of list){if('focus' in client){client.navigate(url);return client.focus();}}
    return clients.openWindow(url);
  }));
});
