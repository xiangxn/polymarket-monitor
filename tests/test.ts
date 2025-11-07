import Table from 'cli-table3';
import UpdateManager from 'stdout-update';

const manager = UpdateManager.getInstance();
manager.hook();

let counter = 0;

setInterval(() => {
    const p = new Table({
        head: ["#","Name","Balance"],
    });

    const data = [
        { "#": counter+1, Name: "Alice", Balance: (Math.random() * 1000).toFixed(2) },
        { "#": counter+2, Name: "Bob", Balance: (Math.random() * 1000).toFixed(2) },
    ]
    p.push(...data.map(d=>Object.values(d)));

    manager.update(p.toString().split("\n")); // 💥 原地刷新
    counter++;
}, 500);

process.on('SIGINT', () => {
    manager.unhook(false);
    process.exit(0);
});
