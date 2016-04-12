/**
 * Created by BronzeBee on 09.04.2016.
 */

/**
 * Подключем модули
 * @type {exports|module.exports}
 */
var fs = require("fs");
var winston = require("winston");
var moment = require("moment");
var SteamUser = require("steam-user");
var SteamCommunityContainer = require("steamcommunity");
var SteamTotp = require("steam-totp");
var TradeOfferManager = require("steam-tradeoffer-manager");
var mongodb = require("mongodb");
var MongoClient = mongodb.MongoClient;
var crypto = require("crypto");
var async = require("async");
var request = require('request');

/**
 * База данных
 */
var db;

/**
 * Авторизирован ли бот
 * @type {boolean}
 */
var LOGGED_IN = false;

/**
 * Выводит все необходимое в консоль и в файл
 */
var logger = createLogger();

/**
 * Конфигурация бота
 */
var config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));

/**
 * Пользователи, которыс будут отправляться уведомления в Steam
 * @type {Array}
 */
var notificationUsers = [];

/**
 * Инициализируем клиент Steam и менеджер обменов
 * @type {SteamUser|exports|module.exports}
 */
var steamClient = new SteamUser();
var tradeManager = new TradeOfferManager({
    "steam": steamClient,
    "domain": "dota2bets.ru",
    "language": "en"
});
var steamCommunity = new SteamCommunityContainer();

/**
 * Объект, несущий информацию о текущей игре
 */
var currentGame;

/**
 * Общая информация об играх (из базы данных)
 * @type {{}}
 */
var globalInfo = {};

/**
 * Обмены, находящиеся в очереди
 * @type {{}}
 */
var queuedTrades = {};

/**
 * Выделил все операции с маркетом в отдельный объект
 * @type {MarketHelper}
 */
var marketHelper;

/**
 * Запускаем бота
 */
main();

function main() {
    logger.info("********** Конфуций v2.01 **********");
    logger.info("Установка соединения с базой данных");
    connectToDB(function (database) {
        db = database;
        initInfo(function () {
            initGame(function () {
                auth();
            });
        });
    });
}

/**
 * Достаем общую инфомацию из базы данных
 * @param callback функция обратного вызова
 */
function initInfo(callback) {
    var info = db.collection("info").find();
    info.toArray(function (err, items) {
        if (err) {
            logger.error(err.stack || err);
            terminate();
        } else {
            async.forEachOfSeries(items, function (data, index, cb) {
                globalInfo[data.name] = data.value;
                cb();
            }, function () {
                callback();
            });
        }
    });

}

function initGame(callback) {
    db.collection("games").find({id: globalInfo["current_game"]}).toArray(function (err, items) {
        if (err) {
            logger.error(err.stack || err);
            terminate();
        } else {
            if (items.length > 0) {
                var gameData = items[0];
                currentGame = new Game(globalInfo["current_game"]);
                currentGame.resume(gameData.start_time, gameData.bank, gameData.items, gameData.float, gameData.hash);
            } else {
                //Создаем новую игру
            }
        }
    });
}

/**
 * Авторизируемся через Steam
 */
function auth() {
    var logOnOptions = config["logOnOptions"];
    logger.info("Установлен пользователь: " + logOnOptions.accountName);
    logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(logOnOptions.sharedSecret);
    logger.info("Авторизация");
    steamClient.setSentry(fs.readFileSync("./sentry.txt"));

    /**
     * В случае, если через 5 секунд бот по каким-либо
     * причинам все еще не залогинен, выключаемся.
     * (мера предосторожности)
     */
    setTimeout(function () {
        if (!LOGGED_IN) {
            logger.error("Авторизация не удалась");
            terminate();
        }
    }, 5000);

    steamClient.logOn(logOnOptions);
}


/**
 * Коннектим базу данных
 */
function connectToDB(callback) {
    MongoClient.connect(config.mongodb.url, function (err, db) {
        if (err) {
            logger.error("Не удалось соединиться с базой данных:");
            logger.error(err.stack || err);
            terminate();
        } else {
            logger.info("Соединение с базой данных установлено");
            db.collection("users").find({"notify": 1}).toArray(function (err, items) {
                if (err) {
                    logger.error(err.stack || err);
                    terminate();
                } else {
                    async.forEachOfSeries(items, function (data, key, cb) {
                        notificationUsers.push(data.steamid);
                        cb();
                    }, function () {
                        callback(db);
                    });
                }
            });

        }
    });
}

/**
 * Уведомляем царей об успешной авторизации
 */
steamClient.on('loggedOn', function () {
    LOGGED_IN = true;
    /**
     * Код авторизации больше не нужен
     */
    delete config.logOnOptions.twoFactorCode;
    steamClient.setPersona(SteamUser.Steam.EPersonaState.LookingToTrade);
    notifyAdmins(moment().format("HH:mm:ss") + " - Авторизирован.", true);
    marketHelper = new MarketHelper();
});

/**
 * Обрабатываем сообщения в чате
 */
steamCommunity.on('chatMessage', function (sender, text) {
    text = text.trim();
    if (config.admins.indexOf(sender.getSteamID64()) >= 0 && text.charAt(0) == "/") {
        var args = text.replace("/", "").split(" ");
        var command = args[0];
        args.splice(0, 1);
        executeCommand(command, args, sender.getSteamID64());
    }
});


/**
 * Генерируем API key и запускаем получение
 * новых кодов подтверждения
 */
steamClient.on('webSession', function (sessionID, cookies) {
    tradeManager.setCookies(cookies, function (err) {
        if (err) {
            logger.error("Не удалось получить API key");
            logger.error(err.stack || err);
            terminate();
            return;
        }
        logger.info("Получен API key: " + tradeManager.apiKey);
    });
    steamCommunity.setCookies(cookies);
    steamCommunity.chatLogon();
    steamCommunity.startConfirmationChecker(30000, config["identitySecret"]);
});

/**
 * Обрабатываем обмен
 */
tradeManager.on('newOffer', function (offer) {
    if (globalInfo["trading"] === true) {
        /**
         * Если новый обмен не активен или залагал,
         * пропускаем его
         */
        if (offer.state === 2 && !offer._isGlitched()) {
            //socket.emit("event.process_offer", {steamid: offer.partner.getSteamID64()});
            getSteamUser(offer.partner.getSteamID64(), function (user) {
                notifyAdmins("Получено предложение об обмене #" + offer.id + " от " + user.name, true);
                /**
                 * Удостоверимся, что пользователь только вносит предметы
                 */
                if (offer.itemsToGive.length <= 0) {
                    /**
                     * Проверим, не скрыт ли профиль
                     */
                    if (user.privacyState === "public") {
                        /**
                         * Проверяем, привязал ли пользователь мобильный телефон
                         * (чтобы обмен не завис на три дня)
                         */
                        if (offer.confirmationMethod === 2) {
                            /**
                             * Обрабатываем предметы
                             * @see {#processItems}
                             */
                            processItems(offer, function (items, totalCost, appIDMatch, marketError) {
                                /**
                                 * Удостоверимся, что все предметы из нужной игры
                                 */
                                if (appIDMatch) {
                                    /**
                                     * Проверяем наличие других ошибок
                                     * @see {#processItems}
                                     */
                                    if (!marketError) {
                                        /**
                                         * Превосходит ли стоимость предметов минимальную ставку
                                         */
                                        if (totalCost >= Number(globalInfo["min_bet"]) * 100) {
                                            /**
                                             * Удостоверимся, что число предметов за один обмен
                                             * не превосходит максимальное разрешенное
                                             */
                                            if (items.length <= globalInfo["max_items_per_trade"]) {
                                                /**
                                                 * Проверяем, не станет ли общее число предметов в игре
                                                 * больше максимального
                                                 */
                                                if (items.length + currentGame.items.length <= globalInfo["max_items"]) {
                                                    if (currentGame)
                                                    acceptOffer(function () {
                                                        /**
                                                         * Обязательно проверяем подтверждения через
                                                         * мобильный аутентификатор
                                                         */
                                                        steamCommunity.checkConfirmations();
                                                        //socket.emit("event.process_offer.success", {steamid: user.steamID.getSteamID64()});
                                                        notifyAdmins("Предложение #" + offer.id + " принято", true);

                                                    });
                                                } else {
                                                    declineOffer(offer, "общее кол-во предметов не должно превышать " + globalInfo["max_items"], function () {
                                                        //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "too_many_items"});
                                                    });
                                                }
                                            } else {
                                                declineOffer(offer, "обмен содержит больше " + globalInfo["max_items_per_trade"] + "предметов", function () {
                                                    //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "too_many_items_in_trade"});
                                                });
                                            }
                                        } else {
                                            declineOffer(offer, "ставка меньше минимальной", function () {
                                                //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "low_bet"});
                                            });
                                        }
                                    } else {
                                        declineOffer(offer, marketError.message, function () {
                                            //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: marketError.reason});
                                        });
                                    }
                                } else {
                                    declineOffer(offer, "обмен содержит предметы из других игр", function () {
                                        //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "items_to_give"});
                                    });
                                }
                            });
                        } else {
                            declineOffer(offer, "профиль пользователя не привязан к мобильному аутентификатору Steam Guard", function () {
                                //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "no_mobile_auth"});
                            });
                        }
                    } else {
                        declineOffer(offer, "профиль пользователя скрыт", function () {
                            //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "private_profile"});
                        });
                    }
                } else {
                    declineOffer(offer, "попытка вывести предметы", function () {
                        //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "items_to_give"});
                    });
                }
            });
        } else {
            notifyAdmins("Найдено недействительное предложение об обмене (#" + offer.id + "), игнорирую", true);
        }
    }
    // console.log(offer);
    //   console.log("*********************");
    //   console.log(offer.partner);
    /* offer.accept(function (err) {
     if (err) {
     logger.error("Ошибка во время принятия обмена");
     logger.error(err.message);
     } else {
     steamCommunity.checkConfirmations();
     logger.info("Обмен принят");
     notifyAdmins("Обмен принят");
     }
     });*/
});

function acceptOffer(offer, callback, depth) {
    var partnerID = offer.partner.getSteamID64();
    offer.accept(function (err) {
        if (err) {
            logger.error("Не удалось принять обмен");
            logger.error(err.stack || err);
            if (!depth)
                depth = 1;
            else
                depth++;
            if (depth < 5) {
                logger.error("Следующая попытка через 1.5с.");
                setTimeout(function () {
                    acceptOffer(offer, callback, depth);
                }, 1500);
            } else {
                declineOffer(offer, "неизвестная ошибка при принятии обмена", function () {
                    //socket.emit("event.process_offer.fail", {steamid: partnerID, reason: "steam_error"});
                });
            }
        } else {
            callback();
        }
    });
}

function insertItemsToDB(items, callback) {

}

/**
 * Обрабатываем предметы; возвращаем следующее:
 *  items - обработанный массив предметов
 *  totalCost - их полная стоимость
 *  appIDMatch - имеют ли ВСЕ предметы заданный appID
 *  marketError - объект, содержащий описание ошибки маркета:
 *    message - сообщение об ошибке
 *    reason - код события для передачи по сокету
 * @param offer предложение обмена
 * @param callback функция обратного вызова
 */
function processItems(offer, callback) {
    var totalCost = 0;
    var appIDMatch = true;
    var items = offer.itemsToReceive;
    var marketError = false;
    async.forEachOfSeries(items, function (item, key, cb) {
        if (item.appid !== config["appID"]) {
            appIDMatch = false
        } else {
            var marketInfo = marketHelper.getItemData(item.market_hash_name);
            if (!marketInfo) {
                marketError = {
                    message: "Предмета " + item.name + " нет на торговой площадке",
                    reason: "no_market_lots"
                };
            } else if (Number(marketInfo.quantity) < config["marketLotsRequired"]) {
                marketError = {
                    message: "Недостаточное кол-во лотов " + item.name + "на торговой площадке (" + marketInfo.quantity + ")",
                    reason: "not_enough_market_lots"
                };
            } else {
                totalCost += Number(marketInfo.value);
                item.owner = offer.partner.getSteamID64();
            }
        }
        cb();
    }, function () {
        callback(items, totalCost, appIDMatch, marketError);
    });
}

function declineOffer(offer, reason, callback, depth) {
    offer.decline(function (err) {
        if (err) {
            logger.error("Не удалось отклонить обмен");
            logger.error(err.stack || err);
            if (!depth)
                depth = 1;
            else
                depth++;
            if (depth < 5) {
                logger.error("Следующая попытка через 3с.");
                setTimeout(function () {
                    declineOffer(offer, reason, callback, depth);
                }, 3000);
            }
        } else {
            notifyAdmins("Предложение обмена #" + offer.id + " отклонено: " + reason, true);
            callback();
        }
    });
}

function getSteamUser(id, callback, depth) {
    steamCommunity.getSteamUser(id, function (err, user) {
        if (err) {
            logger.error("Ошибка при получении данных пользователя " + id);
            logger.error(err.stack || err);
            if (!depth)
                depth = 1;
            else
                depth++;
            if (depth < 5) {
                logger.error("Следующая попытка через 3с.");
                setTimeout(function () {
                    getSteamUser(id, callback, depth);
                }, 3000);
            }
        } else {
            callback(user);
        }
    });
}

/**
 * Отправляет сообщение всем царям
 * @param msg текст сообщения
 * @param echo логгировать ли сообщение [optional]
 */
function notifyAdmins(msg, echo) {
    if (echo)
        logger.info(msg);
    config.admins.forEach(function (admin) {
        if (notificationUsers.indexOf(admin) >= 0)
            steamClient.chatMessage(admin, msg);
    });
}

/**
 * Создаем логгер.
 * Последний файл вывода носит имя latest.log.
 * Предыдущий файл вывода переименовывается по
 * заранее записанной дате.
 */
function createLogger() {
    function formatter(args) {
        var date = moment().format("HH:mm:ss");
        var logMessage = "[" + date + " " + args.level.toUpperCase() + "]: " + args.message;
        return logMessage;
    }

    var dateString = moment().format("YYYY-MM-DD HH-mm-ss");
    if (fs.existsSync("./logs/confucius/logdata.json")) {
        var logData = JSON.parse(fs.readFileSync("./logs/confucius/logdata.json", "utf-8"));
        if (fs.existsSync("./logs/confucius/latest.log")) {
            fs.rename("./logs/confucius/latest.log", "./logs/confucius/" + logData["last_date"] + ".log", function () {
            });
        }
        logData["last_date"] = dateString;
        fs.writeFileSync("./logs/confucius/logdata.json", JSON.stringify(logData), "utf-8");
    } else {
        var logData = {"last_date": dateString};
        fs.writeFileSync("./logs/confucius/logdata.json", JSON.stringify(logData), "utf-8");
    }
    var logger = new winston.Logger({
        json: false,
        transports: [
            new (winston.transports.Console)({
                handleExceptions: true,
                json: false,
                formatter: formatter
            }),
            new (winston.transports.File)({
                filename: './logs/confucius/latest.log',
                handleExceptions: true,
                json: false,
                formatter: formatter
            })
        ]
    });
    return logger;
}

/**
 * Выходим из Steam и завершаем процесс
 * @param printf функция логгинга [optional]
 */
function terminate(printf) {
    if (printf)
        printf("Закрытие соединения и завершение работы");
    else
        logger.info("Закрытие соединения и завершение работы");
    if (LOGGED_IN) {
        steamCommunity.chatLogoff()
        steamClient.logOff();
    }
    if (db)
        db.close();
    if (marketHelper)
        clearTimeout(marketHelper.taskID);

    setTimeout(function () {
        process.exit(0);
    }, 2000);
}

/**
 * Класс, описывающий данные игры
 * @param id номер игры
 * @constructor
 */
function Game(id) {
    this.id = id;
    this.gameTimer = Number(config["gameDuration"]);
    this.currentBank = 0;
    this.items = [];
    this.float = Math.random();
    this.hash = crypto.createHash('md5').update(this.float).digest('hex');
    this.timerID = -1;
    this.betsInfo = {};
}

Game.prototype.sortItemsByOwner = function (items) {
    var sortedItems = {};
    async.forEachOfSeries(items, function (item, index, callback) {
        if (sortedItems[item.owner]) {
            sortedItems[item.owner].push(item);
        } else {
            sortedItems[item.owner] = [];
            sortedItems[item.owner].push(item);
        }
        callback();
    }, function () {
        return sortedItems;
    });
}

/**
 * Если игра была прервана, возобновляем её
 * Все значения должны браться из базы данных
 * @param timer время до конца игры (в секундах)
 * @param bank полная стоимость предметов в игре
 * @param items все предметы в текущей игре
 * @param float число раунда
 * @param hash хэш раунда
 */
Game.prototype.resume = function (starttime, bank, items, float, hash) {
    this.currentBank = bank;
    this.items = items;
    this.float = float;
    this.hash = hash;
    this.ownerSortedItems = this.sortItemsByOwner(this.items);
    if (starttime > 0) {
        if (Date.now() - starttime >= Number(config["gameDuration"]) * 1000) {
            //proceed winners
        } else {
            this.gameTimer = Math.max(1, Number(((Date.now() - starttime) / 1000).toFixed(0)));
            this.start();
        }
    } else if (Object.keys(this.ownerSortedItems).length >= 2) {
        var start = Date.now();
        db.collection("games").updateOne({id: this.id}, {$set: {start_time: start}}, {w: 1}, function (err, result) {
            if (err) {
                logger.error(err.stack || err);
                terminate();
            } else {
                globalInfo.start_time = start;
                this.gameTimer = Number(config["gameDuration"]);
                this.start();
            }
        });
    }
}

/**
 * Запускаем отсчет до конца игры
 */
Game.prototype.start = function () {
    this.timerID = setInterval(function () {
        this.gameTimer--;
        //socket.emit("event.main_timer", this.gameTimer);
        if (this.gameTimer <= 0) {
            clearInterval(this.timerID);
        }
    }, 1000);
}

Game.prototype.selectWinner = function () {
    var winnerNumber = (this.currentBank * this.float).toFixed(2) * 100;
    this.items.forEach(function (item, index, array) {
        if (winnerNumber > item.from && winnerNumber < item.to) {

        }
    });
}


/**
 * Выполняет соответствующую команду
 * @param command название команды
 * @param args аргументы
 * @param sender SteamID отправителя
 */
function executeCommand(command, args, sender) {
    switch (command) {
        case "terminate":
        {
            notifyAdmins("Пользователь " + sender + " использовал команду terminate");
            var msg = "الله أكبر";
            steamClient.chatMessage(sender, msg);
            steamClient.chatMessage(sender, "BOOM");
            setTimeout(function () {
                terminate();
            }, 2000);
            break;
        }
        case "notifications":
        {
            if (args.length != 1) {
                steamClient.chatMessage(sender, "Использование: /notifications [on/off/status]");
            } else {
                if (args[0] === "status") {
                    if (notificationUsers.indexOf(sender) >= 0) {
                        steamClient.chatMessage(sender, "Уведомления сейчас ВКЛЮЧЕНЫ");
                    } else {
                        steamClient.chatMessage(sender, "Уведомления сейчас ОТКЛЮЧЕНЫ");
                    }
                } else if (args[0] === "on") {
                    db.collection("users").updateOne({steamid: sender}, {$set: {notify: 1}}, {w: 1}, function (err, result) {
                        if (err) {
                            steamClient.chatMessage(sender, "Произошла ошибка, попытайтесь снова");
                            logger.error(err.stack || err);
                        } else {
                            notificationUsers.push(sender);
                            steamClient.chatMessage(sender, "Уведомления были ВКЛЮЧЕНЫ");
                        }
                    });
                } else if (args[0] === "off") {
                    db.collection("users").updateOne({steamid: sender}, {$set: {notify: 0}}, {w: 1}, function (err, result) {
                        if (err) {
                            steamClient.chatMessage(sender, "Произошла ошибка, попытайтесь снова");
                            logger.error(err.stack || err);
                        } else {
                            notificationUsers.splice(notificationUsers.indexOf(sender), 1);
                            steamClient.chatMessage(sender, "Уведомления были ОТКЛЮЧЕНЫ");
                        }
                    });
                } else {
                    steamClient.chatMessage(sender, "Использование: /notifications [on/off/status]");
                }
            }
            break;
        }
        case "trading":
        {
            if (args.length != 1) {
                steamClient.chatMessage(sender, "Использование: /trading [on/off/status]");
            } else {
                if (args[0] === "status") {
                    if (globalInfo["trading"] === true) {
                        steamClient.chatMessage(sender, "Обработка обменов сейчас ВКЛЮЧЕНА");
                    } else {
                        steamClient.chatMessage(sender, "Обработка обменов сейчас ОТКЛЮЧЕНА");
                    }
                } else if (args[0] === "on") {
                    db.collection("info").updateOne({name: "trading"}, {$set: {value: true}}, {w: 1}, function (err, result) {
                        if (err) {
                            steamClient.chatMessage(sender, "Произошла ошибка, попытайтесь снова");
                            logger.error(err.stack || err);
                        } else {
                            globalInfo["trading"] = true;
                            steamClient.chatMessage(sender, "Обработка обменов была ВКЛЮЧЕНА");
                        }
                    });
                } else if (args[0] === "off") {
                    db.collection("info").updateOne({name: "trading"}, {$set: {value: false}}, {w: 1}, function (err, result) {
                        if (err) {
                            steamClient.chatMessage(sender, "Произошла ошибка, попытайтесь снова");
                            logger.error(err.stack || err);
                        } else {
                            globalInfo["trading"] = false;
                            steamClient.chatMessage(sender, "Обработка обменов была ОТКЛЮЧЕНА");
                        }
                    });
                } else {
                    steamClient.chatMessage(sender, "Использование: /trading [on/off/status]");
                }
            }
            break;
        }
        case "iteminfo":
        {
            if (args.length <= 0) {
                steamClient.chatMessage(sender, "Использование: /iteminfo [назание предмета]");
            } else {
                var name = args.join(" ").trim();
                var item = marketHelper.getItemData(name);
                if (item) {
                    steamClient.chatMessage(sender, "Последнее обновление: " + moment(item.last_updated + ".000", "X").format("DD.MM.YY, HH:mm:ss"));
                    steamClient.chatMessage(sender, "Кол-во лотов на маркете: " + item.quantity);
                    steamClient.chatMessage(sender, "Цена: " + (Number(item.value) / 100).toFixed(2) + "$");
                } else {
                    steamClient.chatMessage(sender, "Предмет не найден");
                }
            }
            break;
        }
        case "help":
        {
            steamClient.chatMessage(sender, "Помощь тут");
            break;
        }
        default:
        {
            steamClient.chatMessage(sender, "Неизвестная команда");
        }
    }

}

/**
 * Класс для операций над торговой площадкой
 * @constructor
 */
function MarketHelper() {
    this.taskID = -1;
    this.priceData = {};
    if (!config["lastPriceUpdate"] || Date.now() - config["lastPriceUpdate"] >= Number(config["priceUpdateInterval"]) * 1000) {
        this.cachePrices();
    } else {
        this.priceData = JSON.parse(fs.readFileSync("./prices.json", "utf-8"));
        this.taskID = setTimeout(function () {
            this.cachePrices();
        }, (Number(config["priceUpdateInterval"]) * 1000) - (Date.now() - Number(config["lastPriceUpdate"])));
    }
}

/**
 * Возвращает объект со следующими данными о предмете:
 *  last_updated - последнее обновление цены (не используем)
 *  quantity - кол-во лотов на маркете (если меньше 10, отклоняем обмен)
 *  value - цена в центах
 * @param marketHashName
 * @returns {*}
 */
MarketHelper.prototype.getItemData = function (marketHashName) {
    return this.priceData[marketHashName];
}

/**
 * Кэширует цены всех предметов с маркета
 * в файл prices.json с помощью API backpack.tf
 */
MarketHelper.prototype.cachePrices = function () {
    logger.info("Идет кэширование цен, может занять до 1 минуты");
    var url = "http://backpack.tf/api/IGetMarketPrices/v1/?format=json&appid=" + config["appID"] + "&key=" + config["bptfAPIKey"];
    request(url, function (err, response, body) {
        if (err) {
            logger.error("Не удалось прокэшировать цены");
            logger.error(err.stack || err);
            logger.error("Повторная попытка через 3с.");
            setTimeout(function () {
                self.cachePrices();
            }, 3000);
        } else {
            var data = JSON.parse(body);
            if (Number(data.response.success) == 1) {
                this.priceData = data.response.items;
                fs.writeFileSync("./prices.json", JSON.stringify(this.priceData, null, 3), "utf-8");
                logger.info("Цены успешно прокэшированы");
                config["lastPriceUpdate"] = Date.now();
                fs.writeFileSync("./config.json", JSON.stringify(config, null, 3), "utf-8");
                this.taskID = setTimeout(function () {
                    self.cachePrices();
                }, Number(config["priceUpdateInterval"]) * 1000);
            } else {
                logger.error("Не удалось прокэшировать цены:");
                logger.error(data.response.message);
                logger.error("Повторная попытка через 3с.");
                setTimeout(function () {
                    self.cachePrices();
                }, 3000);
            }
        }
    });
}

/**
 * Обрабатываем непредвиденные ошибки
 * чтобы безопасно завершить работу
 */
process.on('uncaughtException', function (err) {
    var printf = logger ? logger.error : console.log;
    printf("Непредвиденная ошибка:");
    printf(err.stack || err);
    printf("Приложение будет закрыто");
    terminate(printf);
});

