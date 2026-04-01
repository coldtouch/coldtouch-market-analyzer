async function test() {
    try {
        const url = "https://europe.albion-online-data.com/api/v2/stats/charts/T4_ARMOR_CLOTH_SET1@3,T5_BAG.json?time-scale=24&locations=Bridgewatch";
        const res = await fetch(url);
        console.log("Status:", res.status);
        const data = await res.json();
        console.log("Is array?", Array.isArray(data));
        if (!Array.isArray(data)) {
            console.log(data);
        }
    } catch(e) {
        console.log("ERR:", e);
    }
}
test();
