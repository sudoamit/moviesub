<?php
class Database
{
    protected $connection = null;
    public function __construct()
    {
        try {
            $this->connection = new mysqli(DB_HOST, DB_USERNAME, DB_PASSWORD, DB_DATABASE_NAME);
    	
            if ( mysqli_connect_errno()) {
                throw new Exception("Could not connect to database.");   
            }
        } catch (Exception $e) {
            throw new Exception($e->getMessage());   
        }			
    }


    public function select($query = "" , $params = [])
    {
        try {
            $stmt = $this->executeStatement( $query , $params );
            
            $result = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);				
            $stmt->close();
            return $result;
        } catch(Exception $e) {
            throw New Exception( $e->getMessage() );
        }
        return false;
    }

 
    private function executeStatement($query = "" , $params = [])
    {
        try {
            $stmt = $this->connection->prepare( $query );
          
            if($stmt === false) {
                throw New Exception("Unable to do prepared statement: " . $query);
            }
             if ($params) {
                // Initialize an array to store references to the parameters
                $bindParams = array();

                // Dynamically bind values
                foreach ($params as $paramName => $paramValue) {
                    
                    $bindParams[] = &$params[$paramName];
                }

                // Use call_user_func_array to bind values dynamically
                call_user_func_array(array($stmt, 'bind_param'), $bindParams);
            }
            $boundQuery = str_replace('?', '%s', $query);
            $boundQuery = vsprintf($boundQuery, $bindParams);
            
            $stmt->execute();
            return $stmt;
        } catch(Exception $e) {
            throw New Exception( $e->getMessage() );
        }	
    }

    public function update($query = "" , $params = []) {
        
        try {

            $stmt = $this->executeStatement( $query , $params );
        
            $stmt->close();
        } catch(Exception $e) {
            throw New Exception( $e->getMessage() );
        }
        return false;
      
    }
}