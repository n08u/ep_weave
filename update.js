 var  db = require('../../src/node/db/DB').db,
     API = require('../../src/node/db/API.js'),
   async = require('../../src/node_modules/async'),
   check = require('validator').check,
settings = require('../../src/node/utils/Settings');

var pluginSettings = settings.ep_email_notifications;
var checkInterval = 60000; // Move me to the settings file
var staleTime = 3600000; // Move me to settings
var timers = {};

// When a new message comes in from the client
exports.handleMessage = function(hook_name, context, callback){
  if (context.message && context.message.data){
    if (context.message.data.type == 'USERINFO_UPDATE' ) { // if it's a request to update an authors email
      if (context.message.data.userInfo){
        if(context.message.data.userInfo.email){ // it contains email
          console.debug(context.message);

          // does email Subscription already exist for this email address?
          db.get("emailSubscription:"+context.message.data.padId, function(err, userIds){

            var alreadyExists = false;
            if(userIds){
              async.forEach(Object.keys(userIds), function(user, cb){ 
                console.debug("UserIds subscribed by email to this pad:", userIds);
                  if(user == context.message.data.userInfo.email){ //  If we already have this email registered for this pad
  
                  // This user ID is already assigned to this padId so don't do anything except tell the user they are already subscribed somehow..
                  alreadyExists = true;
                  console.debug("email ", user, "already subscribed to ", context.message.data.padId, " so sending message to client");
  
                  context.client.json.send({ type: "COLLABROOM",
                    data:{
                      type: "emailSubscriptionSuccess",
                      payload: false
                    }
                  });
                }
                cb();
              },
  
              function(err){
                // There should be something in here!
              }); // end async for each
            }

            var validatesAsEmail = check(context.message.data.userInfo.email).isEmail();
            if(!validatesAsEmail){ // send validation failed if it's malformed..  y'know in general fuck em!
              console.warn("Dropped email subscription due to malformed email address");
              context.client.json.send({ type: "COLLABROOM",
                data:{
                  type: "emailSubscriptionSuccess",
                  payload: false
                 }
              });
            }

            if(alreadyExists == false && validatesAsEmail == true){
 
              console.warn ("Wrote to the database and sent client a positive response ",context.message.data.userInfo.email);
  
              exports.setAuthorEmail(
                context.message.data.userInfo.userId, 
                context.message.data.userInfo.email, callback
              );
 
              exports.setAuthorEmailRegistered(
                context.message.data.userInfo.email,
                context.message.data.userInfo.userId,
                context.message.data.padId
              );
   
              context.client.json.send({ type: "COLLABROOM",
                data:{
                  type: "emailSubscriptionSuccess",
                  payload: true
                 }
              });
            }
          }); // close db get

          callback(null); // don't run onto passing colorId or anything else to the message handler

        }
      }
    }
  }
  callback();
}

exports.doesPadIdEmailAssociationAlreadyExist = function (padId, email){
  var found = false;
  db.get("emailSubscription:"+padId, function(err, value){
    return value;
  });
}

exports.padUpdate = function (hook_name, _pad) {

  var pad = _pad.pad;
  var padId = pad.id;
  exports.sendUpdates(padId);

  // does an interval not exist for this pad?
  if(!timers[padId]){
    console.debug("Created an interval time check for "+padId);
    // if not then create one and write it to the timers object
    timers[padId] = exports.createInterval(padId, checkInterval); 
  }else{ // an interval already exists so don't create

  }

};

exports.sendUpdates = function(padId){

  // check to see if we can delete this interval
  API.getLastEdited(padId, function(callback, message){

    // we delete an interval if a pad hasn't been edited in X seconds.
    var currTS = new Date().getTime();
    if(currTS - message.lastEdited > staleTime){
      console.warn("Interval went stale so deleting it from object and timer");
      var interval = timers[padId];
      clearInterval(timers[padId]); // remove the interval timer
      delete timers[padId]; // remove the entry from the padId
      
    }else{
      console.debug("email timeotu not stale so not deleting");
    }

  });

  // The status of the users relationship with the pad -- IE if it's subscribed to this pad / if it's already on the pad
  // This comes frmo the database
  var userStatus = {};

  // Temporary user object
  var user = {
    name:  "John McLear",
    email: "john@mclear.co.uk",
    id:    "a.n4gEeMLsv1GivNeh"
  }

  console.debug("ep_email_noficiations: padID of pad being edited:"+padId);
  exports.isUserEditingPad(padId, user, function(err,results){
    userStatus.userIsEditing = results;
    console.debug("isUserEditingPad is:", results);
  });

}


// Is the user editing the pad?
exports.isUserEditingPad = function(padId, user, cb){
  API.padUsers(padId, function(callback, padUsers){ // get the current users editing the pad

    var userIsEditing = false;
    console.debug("Pad Users:"+padUsers);

    // for each user on the pad right now
    async.forEach(padUsers.padUsers,

      function(userOnPad, callback){

        if(userOnPad.id == user.id){
          console.debug("I'm on the pad so don't send any notification");
          userIsEditing = true; // If the user is editing the pad then return true
        }else{
          userIsEditing = false; // If the user isnt on this pad then that'd be okay to contact em
        }
        callback(userIsEditing);

      },

      function(err){
        cb(null, userIsEditing);
      });

   });
};

// Creates an interval process to check to send Updates based on checkInterval and it returns an ID
exports.createInterval = function(padId){
  return setInterval(function(){
    exports.sendUpdates(padId), checkInterval
  });
}

// Updates the database with the email record
exports.setAuthorEmail = function (author, email, callback){
  db.setSub("globalAuthor:" + author, ["email"], email, callback);
}

// Write email and padId to the database
exports.setAuthorEmailRegistered = function(email, authorId, padId){
  var timestamp = new Date().getTime();
  var registered = {
      authorId: authorId,
      timestamp: timestamp
  };
  console.debug("registered", registered, " to ", padId);

  // Here we have to basically hack a new value into the database, this isn't clean or polite.
  db.get("emailSubscription:" + padId, function(err, value){ // get the current value
    if(!value){value = {};} // if an emailSubscription doesnt exist yet for this padId don't panic
    value[email] = registered; // add the registered values to the object
    db.set("emailSubscription:" + padId, value); // stick it in the database
  });

}
