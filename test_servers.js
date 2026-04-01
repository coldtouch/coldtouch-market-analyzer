async function run() {
    try {
        const res = await fetch("https://raw.githubusercontent.com/broderickhyman/albiondata-client/master/locations.json");
        const data = await res.json();
        const cities = ['Martlock', 'Thetford', 'Fort Sterling', 'Lymhurst', 'Bridgewatch', 'Caerleon', 'Brecilien', 'Black Market'];
        const map = {};
        for (const [id, name] of Object.entries(data)) {
            if (cities.includes(name)) {
                map[id] = name;
            }
        }
        console.log(JSON.stringify(map, null, 2));
    } catch(e) {
        console.log("ERR", e);
    }
}
run();
