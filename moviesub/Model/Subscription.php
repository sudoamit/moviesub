<?php
require_once PROJECT_ROOT_PATH . "/Model/Database.php";
class Subscription extends Database
{
    public function getSubscription($user_id)
    {
        return $this->select("SELECT * FROM subscription where user_id =  ?", ["i",1]);
    }

    public function removeSubscription($user_id, $subscription_id)
    {
        return $this->update("UPDATE subscription SET is_subscribed = '0' WHERE user_id = {$user_id} AND id = ?", ["i",1]);
    }
}