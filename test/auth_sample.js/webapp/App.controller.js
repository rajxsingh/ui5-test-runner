sap.ui.define(
  ["sap/ui/core/mvc/Controller", "sap/m/MessageToast"],
  function (Controller, MessageToast) {
    "use strict";

    return Controller.extend("auth.sample.js.App", {
      onInit: function () {},

      onPress: function () {
        MessageToast.show("Hello World!");
      },
    });
  }
);
