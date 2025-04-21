const axios = require('axios');

const testOrder = {
  exchange: "gmx",
  strategy: "testStrategy",
  market: "BTC_USD",
  sizeUsd: "1800",
  reverse: false,
  order: "buy",
  position: "long",
  price: "market"
};

axios.post('http://localhost:3000/', testOrder)
  .then(response => {
    console.log("Order sent successfully:", response.data);
  })
  .catch(error => {
    console.error("Error sending order:", error.response ? error.response.data : error.message);
  });
