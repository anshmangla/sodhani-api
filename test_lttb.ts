import { lttb } from './src/utils/lttb';

const data = [];
for(let i=0; i<3956; i++) {
  data.push({
    record_date: new Date(Date.now() + i * 86400000),
    close_price: Math.random() * 100
  });
}

try {
  const result = lttb(
    data, 
    500, 
    (d) => d.record_date.getTime(),
    (d) => Number(d.close_price)
  );
  console.log('LTTB Output Length:', result.length);
} catch (e) {
  console.error('LTTB Error:', e.message);
}
